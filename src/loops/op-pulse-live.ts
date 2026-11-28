// OP-PULSE live probes — every value comes from an existing ledger/CLI and fails open to «?» (never read as zero):
//   schedule      release-schedule listSchedules()
//   cells         checklist listChecklist(current version) — green/h = cells turned green in the last hour (updatedAt)
//   hands         seat/hand-pool-live liveHandPool() — per home space: hands · idle hands
//   blocked       steward/space/cell-block openBlocks(cell-blocks.jsonl)
//   judge queue   release-loop/green-triage triageGreen() judge rows (age = cell updatedAt)
//   landed/h      git log origin/main --since (squash subjects «(#N)»)
//   budget        budget/unified-usage collectUnifiedUsage() — codex/openrouter rows
//   crown mails   msg store listCreatedBetween(since, now)
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { elanousCliArgv, installedBin } from '../instance/cli-bin.js';
import { median, type PulseMeasure, type SpaceMeasure } from './op-pulse.js';
import type { PulseExtra, PulseProbes } from './op-pulse-run.js';
import type { BurstLaunch, BurstState } from './op-pulse-burst.js';
import type { BurstActuatorPolicy, BurstActuators, BurstUnit } from './op-pulse-burst-actuate.js';

const short = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 80);
const HOUR = 3_600_000;

function landedSince(sinceMs: number, cwd: string): Set<number> | null {
  const out = spawnSync('git', ['-C', cwd, 'log', 'origin/main', `--since=${new Date(sinceMs).toISOString()}`, '--format=%s'], { encoding: 'utf8', timeout: 20_000 });
  if (out.status !== 0) return null;
  const prs = new Set<number>();
  for (const line of out.stdout.split('\n')) { const m = /\(#(\d+)\)\s*$/u.exec(line); if (m) prs.add(Number(m[1])); }
  return prs;
}

/** The pulse graph's measure step: the live probes plus the OP next-action planner's live snapshot and actuators. */
export function livePulseProbesWithPlanner(roots: { stateRoot: string; seatState: string }): PulseProbes {
  return {
    ...livePulseProbes(),
    nextActionState: async (now: Date) => (await import('./op-next-action-live.js')).liveNextActionState(roots, now),
    nextActuators: () => (require('./op-next-action-live.js') as typeof import('./op-next-action-live.js')).liveNextActuators(roots),
    throughput: async (now: Date, stage: string) => (await (await import('./throughput-controller-live.js')).runThroughputLive(roots, now, stage)).block,
    // OP-WORLD-LENS — the world card rides the brief (computed fresh · cache refreshed · Δ against OP's last turn, not advanced).
    worldCard: async (now: Date) => (await import('../op-world/world-lens.js')).freshLensLines('OP', now),
    // BURST-ACTUATOR-WIRED — the lane doors a live burst launches through (els new · eln hosts start · els close).
    burstActuators: (policy: BurstActuatorPolicy) => liveBurstActuators(policy),
  };
}

const inScope = (state: Pick<BurstState, 'scope'>, home: string, seat: string) =>
  state.scope.length === 0 || state.scope.some(s => { const u = s.toUpperCase(); return u === 'ALL' || u === home.toUpperCase() || u === seat.toUpperCase(); });

/** Close one burst launch by its exact id — existing commands only; a lane without one throws (kept as closeFailed). */
export async function liveBurstCloser(l: BurstLaunch): Promise<void> {
  if (l.lane === 'hands' || l.lane === 'remote') {
    const r = spawnSync(installedBin('els'), ['close', l.id], { encoding: 'utf8', timeout: 30_000 }); // Source: one exact pane close per launch · absolute els (cron PATH)
    if (r.status !== 0) throw new Error(`els close ${l.id} exit ${r.status}: ${String(r.stderr).trim().slice(0, 120)}`);
    return;
  }
  if (l.lane === 'ta' || l.lane === 'review') return; // A harness/review child ends on its own; nothing to kill (in-flight work finishes).
  // TODO(OP-PULSE-BURST-VM-STOP): no `eln hosts stop` yet — the receipt lists the VM so OP stops it by hand.
  throw new Error(`${l.lane} ${l.id}: no stop command wired — stop it by hand`);
}

/**
 * The live doors (graphs/policies/burst-actuators.yaml `lanes`):
 *   hands (els-new)     a federation hand seat with no live pane (hand pool «no-pane», in the burst scope) gets one pane:
 *                       els new --ws <home> --cwd <seat-state root>/../<seats_dir>/<SEAT> --title <SEAT> -- <command…> → the pane id is the unit id
 *   vm (hosts-start)    eln hosts start <host> for the first registry burst host (paidHostsFor) the burst has not started — planScale reaches this
 *                       only when local/LAN are full, the forecast misses and the cloud budget (or a CEO card) covers it
 */
export function liveBurstActuators(policy: BurstActuatorPolicy): BurstActuators {
  const up: BurstActuators['up'] = {};
  const hands = policy.lanes.hands;
  if (hands.door === 'els-new' && hands.command?.length && hands.seatsDir) {
    up.hands = async ({ count, state }) => {
      const { resolveSeatStateRoot } = await import('./msg-wake.js');
      const seatsRoot = join(dirname(resolveSeatStateRoot()), hands.seatsDir!);
      const pool = await (await import('../seat/hand-pool-live.js')).liveHandPool({});
      const free = pool.filter(h => h.state === 'no-pane' && inScope(state, h.home, h.seat)).sort((a, b) => a.seat.localeCompare(b.seat));
      const units: BurstUnit[] = []; const skipped: string[] = [];
      for (const h of free) {
        if (units.length >= count) break;
        const cwd = join(seatsRoot, h.seat);
        if (!existsSync(cwd)) { skipped.push(`${h.seat} (no folder)`); continue; }
        const r = spawnSync(installedBin('els'), ['new', '--ws', h.home, '--cwd', cwd, '--title', h.seat, '--', ...hands.command!],
          { encoding: 'utf8', timeout: hands.timeoutSec! * 1000 }); // Source: one pane per hand seat through the els new door · timeout from the policy
        let pane: string | undefined;
        try { pane = (JSON.parse(String(r.stdout)) as { pane?: string }).pane; } catch { pane = undefined; }
        if (r.status !== 0 || !pane) { skipped.push(`${h.seat} (els new exit ${r.status}: ${String(r.stderr || r.stdout).trim().slice(0, 80)})`); continue; }
        units.push({ id: pane, host: h.seat });
      }
      const note = units.length < count ? `free hand seats ${free.length}${skipped.length ? ` · skipped ${skipped.join(', ')}` : ''}` : undefined;
      return { units, ...(note ? { note } : {}) };
    };
  }
  const vm = policy.lanes.vm;
  if (vm.door === 'hosts-start') {
    up.vm = async ({ count, state }) => {
      const started = new Set(state.launches.filter(l => l.lane === 'vm' && !l.closedAt).map(l => l.id));
      const units: BurstUnit[] = []; const failed: string[] = [];
      const { paidHostsFor } = await import('../kit/resource-facts/route.js');
      for (const host of paidHostsFor('burst').filter(h => !started.has(h))) {
        if (units.length >= count) break;
        const [bin, ...pre] = elanousCliArgv();
        const r = spawnSync(bin!, [...pre, 'hosts', 'start', host], { encoding: 'utf8', timeout: vm.timeoutSec! * 1000 }); // Source: the cost-ledger VM door · timeout from the policy
        if (r.status === 0) units.push({ id: host, host }); else failed.push(`${host} exit ${r.status}`);
      }
      return { units, ...(failed.length ? { note: `hosts start failed: ${failed.join(', ')}` } : {}) };
    };
  }
  return { up, close: liveBurstCloser };
}

export function livePulseProbes(): PulseProbes {
  return {
    now: () => new Date(),
    localHour: (d) => d.getHours(),
    schedules() {
      try {
        const { listSchedules } = require('../release-loop/release-schedule.js') as typeof import('../release-loop/release-schedule.js');
        return listSchedules().map(s => ({ version: s.version, cutAt: s.cutAt, publishAt: s.publishAt ?? null }));
      } catch { return []; }
    },
    crownMails(sinceIso, now) {
      try {
        const { MsgStore, defaultMsgStorePath } = require('../msg/msg-store.js') as typeof import('../msg/msg-store.js');
        const store = new MsgStore(defaultMsgStorePath());
        try { return store.listCreatedBetween(sinceIso, new Date(now.getTime() + 1000).toISOString()).filter(m => m.crownDirective).map(m => ({ id: m.id, crownDirective: m.crownDirective ?? null, refs: m.refs ?? null, createdAt: m.createdAt })); }
        finally { store.close(); }
      } catch { return []; }
    },
    async measure(now) {
      const unmeasured: string[] = [];
      const nowMs = now.getTime();
      const { repoRoot } = await import('../domains/schedule-registry.js');
      const cwd = repoRoot();
      spawnSync('git', ['-C', cwd, 'fetch', '-q', 'origin', 'main'], { timeout: 30_000 }); // Source: one fetch per pulse so landed/h is current.
      const landed1h = landedSince(nowMs - HOUR, cwd); const landed3h = landedSince(nowMs - 3 * HOUR, cwd);
      if (!landed1h) unmeasured.push('landed(git log)');
      let version: string | null = null;
      let items: import('../release-loop/checklist.js').ChecklistItem[] | null = null;
      try {
        const { resolveCurrentVersion } = await import('../ops-dashboard/current-version.js');
        const { listChecklist } = await import('../release-loop/checklist.js');
        const { releaseLedgerRoot } = await import('../instance/resolve.js');
        version = resolveCurrentVersion({ hqRoot: join(process.env.HOME ?? '', 'elanous-hq') }).version;
        items = listChecklist(version, releaseLedgerRoot()).items;
      } catch (e) { unmeasured.push(`checklist(${short(e)})`); }
      let pool: Awaited<ReturnType<typeof import('../seat/hand-pool-live.js').liveHandPool>> | null = null;
      try { pool = await (await import('../seat/hand-pool-live.js')).liveHandPool({ now: nowMs }); } catch (e) { unmeasured.push(`hand-pool(${short(e)})`); }
      const homeOf = new Map((pool ?? []).map(h => [h.seat.toUpperCase(), h.home.toUpperCase()] as const));
      const spaceOf = (owner: string | undefined): string | null => { const seat = (owner ?? '').split(/[/:\s]/u)[0]?.toUpperCase() ?? ''; return seat ? homeOf.get(seat) ?? seat : null; };
      let blocked: Map<string, number> | null = null;
      try {
        const { cellBlocksPath, openBlocks, readCellBlockRows } = await import('../steward/space/cell-block.js');
        const { effectiveInstanceRoot } = await import('../instance/resolve.js');
        if (version) { blocked = new Map(); for (const row of openBlocks(readCellBlockRows(cellBlocksPath(effectiveInstanceRoot())), version).values()) { const s = spaceOf(row.by) ?? '?'; blocked.set(s, (blocked.get(s) ?? 0) + 1); } }
      } catch (e) { unmeasured.push(`cell-blocks(${short(e)})`); }
      let judgeAges: number[] | null = null;
      try {
        if (version && items) {
          const { PREGATE_GREEN_DIR, readGreenTriageSources, triageGreen } = await import('../release-loop/green-triage.js');
          const { existsSync, readdirSync } = await import('node:fs');
          const lanes = existsSync(PREGATE_GREEN_DIR) ? readdirSync(PREGATE_GREEN_DIR) : [];
          const triage = triageGreen(version, items, readGreenTriageSources({ greenLanes: () => lanes }));
          const updated = new Map(items.map(i => [i.id, Date.parse(i.updatedAt)] as const));
          judgeAges = triage.rows.judge.map(r => Math.max(0, (nowMs - (updated.get(r.id) ?? nowMs)) / 60_000));
        }
      } catch (e) { unmeasured.push(`judge-queue(${short(e)})`); }
      const budget: string[] = [];
      try {
        const { collectUnifiedUsage } = await import('../budget/unified-usage.js');
        const report = await collectUnifiedUsage();
        for (const r of report.rows) if (r.provider === 'codex' || r.provider === 'openrouter') budget.push(`${r.provider}:${r.accountName} ${JSON.stringify(r.subscription).slice(0, 60)}`);
      } catch (e) { unmeasured.push(`budget(${short(e)})`); }
      const landedPrsBySpace = new Map<string, number>(); const greenBySpace = new Map<string, number>();
      const readyBySpace = new Map<string, number>(); const p0New: number[] = [];
      for (const i of items ?? []) {
        const s = spaceOf(i.owner) ?? 'POOL';
        const t = Date.parse(i.updatedAt);
        if (i.status === 'green' && nowMs - t <= HOUR) greenBySpace.set(s, (greenBySpace.get(s) ?? 0) + 1);
        if (i.status === 'yellow') readyBySpace.set(s, (readyBySpace.get(s) ?? 0) + 1);
        if (i.priority === 'P0' && nowMs - t <= HOUR) p0New.push(t);
        for (const m of (i.evidence ?? '').matchAll(/#(\d{3,6})\b/g)) if (landed1h?.has(Number(m[1]))) landedPrsBySpace.set(s, (landedPrsBySpace.get(s) ?? 0) + 1);
      }
      const spaces = new Set<string>([...(pool ?? []).map(h => h.home.toUpperCase()), ...readyBySpace.keys()]);
      const spaceRows: SpaceMeasure[] = [...spaces].sort().map(space => {
        const hands = pool ? pool.filter(h => h.home.toUpperCase() === space && h.state !== 'no-pane') : null;
        const ready = items ? readyBySpace.get(space) ?? 0 : null;
        return { space, landedPerH: landed1h ? landedPrsBySpace.get(space) ?? 0 : null, greenPerH: items ? greenBySpace.get(space) ?? 0 : null,
          hands: hands ? hands.length : null, idleWithWork: hands && ready !== null ? (ready > 0 ? hands.filter(h => h.state === 'idle').length : 0) : null,
          readyCells: ready, blockedCells: blocked ? blocked.get(space) ?? 0 : null };
      });
      const measure: PulseMeasure = { at: now.toISOString(), version, landedPerH: landed1h ? landed1h.size : null,
        greenPerH: items ? [...greenBySpace.values()].reduce((a, b) => a + b, 0) : null, judgeQueue: judgeAges ? judgeAges.length : null,
        judgeWaitMedianMin: judgeAges ? median(judgeAges) : null, budget, spaces: spaceRows, unmeasured,
        // WORLD-REGISTRY — every actor in one line (lease ledger); unread stays null, never «all well».
        world: (await import('../resource-ledger/world-summary.js')).liveWorldDigest(now)?.line ?? null };
      const open = items ? items.filter(i => i.status !== 'green' && i.status !== 'done').length : null;
      const extra: PulseExtra = { landed3hPerH: landed3h ? landed3h.size / 3 : null, green3hPerH: null,
        readyBacklog: items ? [...readyBySpace.values()].reduce((a, b) => a + b, 0) : null, openInScope: open,
        // TODO(OP-PULSE-DEMAND-BASELINE): baseline P0/h and active CEO requirements need the requirement ledger reader; null = not a surge signal.
        demand: { newP0PerH: items ? p0New.length : null, baselineP0PerH: null, activeRequirements: null, readyBacklogGrowthPerH: null },
        // TODO(OP-PULSE-QUEUE-WAITS): gate/review wait and land queue readers (pregate throughput ledger · review queue · train ledger).
        gateWaitMin: null, reviewWaitMin: null, landQueue: null };
      return { measure, extra };
    },
  };
}
