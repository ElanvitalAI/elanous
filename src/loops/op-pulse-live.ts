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
import { join } from 'node:path';
import { median, type PulseMeasure, type SpaceMeasure } from './op-pulse.js';
import type { PulseExtra, PulseProbes } from './op-pulse-run.js';

const short = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 80);
const HOUR = 3_600_000;

function landedSince(sinceMs: number, cwd: string): Set<number> | null {
  const out = spawnSync('git', ['-C', cwd, 'log', 'origin/main', `--since=${new Date(sinceMs).toISOString()}`, '--format=%s'], { encoding: 'utf8', timeout: 20_000 });
  if (out.status !== 0) return null;
  const prs = new Set<number>();
  for (const line of out.stdout.split('\n')) { const m = /\(#(\d+)\)\s*$/u.exec(line); if (m) prs.add(Number(m[1])); }
  return prs;
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
        judgeWaitMedianMin: judgeAges ? median(judgeAges) : null, budget, spaces: spaceRows, unmeasured };
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
