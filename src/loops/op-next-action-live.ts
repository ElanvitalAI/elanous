// OP-NEXT-BEST-ACTION live probes and actuators (see op-next-action.ts for the SCQA and the three faces).
// Every probe reads an existing ledger and fails open to null (= unmeasured, never «zero»):
//   cells        checklist listChecklist(current version)
//   hands        seat/hand-pool-live liveHandPool() (judge hands marked)
//   directives   msg store: mail to OP in the last 12 h — kind mission, or a crown directive that is not a notice/decision
//   dismissed    {stateRoot}/loops/op-next-action-dismissed.jsonl (`eln pulse dismiss`)
//   split reqs   {stateRoot}/loops/op-split-requests.jsonl (rule (c) records them · 30-min deadline · overdue → forced)
//   hand raises  hand-raise ladder openHands(involving OP)
//   land         {stateRoot}/land-graph/last-tick.json readyNotLanded (OUTCOME-DONE-ALARMS #40264) — fallback: latest
//                `land` decisions without a later `landed` row · landed/1h from the land ledger
//   releases     release schedules ⊕ {stateRoot}/release-graph/<v>/state.json · released = newest published schedule
//   bulletin     mtime of seat-state/OPS/BULLETIN-NOW.md
//   forced       {stateRoot}/loops/op-forced-next.json (turn-end enforcement · actions a no-op turn left pending)
// Actuators: hint = priorityOrder ⊕ pull hint · wake = one [OP · pull] mail ⊕ pane wake (≤15 OP→hand mails/h) · land tick = `eln land graph tick` · release run =
// `eln release graph run` · goals = seat-state/OP/pulse/GOALS-NOW.md. The alarm card is NOT posted here: the trigger
// registry's outcome step (#40264) already cards land/release/bulletin — the planner only acts.
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnElanousSync } from '../instance/spawn-elanous.js';
import { enforcePaths, readForced } from './op-turn-enforce.js';
import type { NaCell, NaDirective, NaHand, NaHandRaise, NaHold, NaRelease, NaSplitRequest, NextActionState, NextActuators, PushPolicy } from './op-next-action.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// 출처: 11-26 test-universe run — a 24 h window listed yesterday's already-handled crown lines (decision/info/announce
// kinds and pre-cut requests); one working day of OP (12 h) keeps today's directives and drops settled ones.
const DIRECTIVE_LOOKBACK_MS = 12 * HOUR;
/** Crown mails of these kinds carry a decision or a notice, not work — no cell is expected. */
const NOT_WORK_KINDS = new Set(['info', 'announce', 'decision', 'ack', 'bulletin', 'beat', 'coach']);
const short = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\s+/gu, ' ').slice(0, 80);

export interface LiveRoots { stateRoot: string; seatState: string }

export const dismissedPath = (stateRoot: string) => join(stateRoot, 'loops', 'op-next-action-dismissed.jsonl');
export const goalsNowPath = (seatState: string) => join(seatState, 'OP', 'pulse', 'GOALS-NOW.md');

export const splitRequestsPath = (stateRoot: string) => join(stateRoot, 'loops', 'op-split-requests.jsonl');

/** The latest split request per cell from the last 24 h (older ones are history, not open requests). */
export function readSplitRequests(stateRoot: string, nowMs: number): NaSplitRequest[] {
  const latest = new Map<string, NaSplitRequest>();
  try {
    for (const l of readFileSync(splitRequestsPath(stateRoot), 'utf8').split('\n')) {
      if (!l.trim()) continue;
      try {
        const r = JSON.parse(l) as Partial<NaSplitRequest>;
        if (typeof r.cell === 'string' && typeof r.at === 'string' && typeof r.deadline === 'string' && Date.parse(r.at) >= nowMs - DAY)
          latest.set(r.cell, { cell: r.cell, at: r.at, deadline: r.deadline, why: typeof r.why === 'string' ? r.why : '' });
      } catch { /* skip */ }
    }
  } catch { /* no ledger */ }
  return [...latest.values()];
}

export function appendSplitRequest(stateRoot: string, row: NaSplitRequest & { by: string }): void {
  const p = splitRequestsPath(stateRoot); mkdirSync(dirname(p), { recursive: true }); appendFileSync(p, `${JSON.stringify(row)}\n`);
}

export function readDismissed(stateRoot: string): number[] {
  try {
    return readFileSync(dismissedPath(stateRoot), 'utf8').split('\n').flatMap(l => { try { const r = JSON.parse(l) as { msgId?: unknown }; return typeof r.msgId === 'number' ? [r.msgId] : []; } catch { return []; } });
  } catch { return []; }
}

export function appendDismissed(stateRoot: string, row: { msgId: number; why: string; by: string; at: string }): void {
  const p = dismissedPath(stateRoot); mkdirSync(dirname(p), { recursive: true }); appendFileSync(p, `${JSON.stringify(row)}\n`);
}

/** Land readings from the land-graph state the land tick already writes. */
export function readLand(stateRoot: string, nowMs: number): NextActionState['land'] {
  const home = join(stateRoot, 'land-graph');
  type LandTick = { readyNotLanded?: unknown; mode?: unknown };
  let tick: LandTick;
  try { tick = JSON.parse(readFileSync(join(home, 'last-tick.json'), 'utf8')) as LandTick; } catch { return null; }
  const rows: Array<{ at?: string; pr?: number; event?: string; action?: string; synthetic?: boolean }> = [];
  try { for (const l of readFileSync(join(home, 'ledger.jsonl'), 'utf8').split('\n')) { if (l.trim()) { try { rows.push(JSON.parse(l)); } catch { /* skip */ } } } } catch { /* no ledger */ }
  const real = rows.filter(r => !r.synthetic);
  const landedLastHour = real.filter(r => r.event === 'landed' && Date.parse(r.at ?? '') >= nowMs - HOUR).length;
  let ready: number | null = typeof tick.readyNotLanded === 'number' ? tick.readyNotLanded : null;
  if (ready === null) {
    const latest = new Map<number, { action?: string; at: number }>(); const landedAt = new Map<number, number>();
    for (const r of real) {
      const t = Date.parse(r.at ?? ''); if (!Number.isFinite(t) || t < nowMs - DAY || typeof r.pr !== 'number') continue;
      if (r.event === 'decision') latest.set(r.pr, { ...(r.action ? { action: r.action } : {}), at: t });
      if (r.event === 'landed') landedAt.set(r.pr, t);
    }
    ready = [...latest].filter(([pr, d]) => d.action === 'land' && !((landedAt.get(pr) ?? -1) >= d.at)).length;
  }
  return { readyToLand: ready, landedLastHour, ...(typeof tick.mode === 'string' ? { mode: tick.mode } : {}) };
}

export function readBulletin(seatState: string, nowMs: number): NextActionState['bulletin'] {
  const p = join(seatState, 'OPS', 'BULLETIN-NOW.md');
  try { return { ageMin: existsSync(p) ? Math.max(0, Math.round((nowMs - statSync(p).mtimeMs) / 60_000)) : null }; } catch { return null; }
}

/**
 * The release in play: the resolver (plan → schedule → package), moved past published versions to the next checklist
 * version (11-26: main still read 0.3.37-dev after 0.3.37 shipped — the same walk as the autopilot standing goal).
 */
export async function versionInPlay(hqRoot: string, ledgerRoot: string): Promise<string> {
  const { resolveCurrentVersion, isPublishedVersion, compareVersions } = await import('../ops-dashboard/current-version.js');
  const { assignedVersions } = await import('../release-loop/feature-store.js');
  let version = resolveCurrentVersion({ hqRoot, ledgerRoot }).version.replace(/-.*$/u, '');
  let assigned: string[] = [];
  try { assigned = assignedVersions(ledgerRoot).filter(v => /^\d+\.\d+\.\d+$/u.test(v)); } catch { /* no ledger */ }
  for (let guard = 0; guard < 20 && isPublishedVersion(version, ledgerRoot); guard++) {
    const next = assigned.filter(v => compareVersions(v, version) > 0).sort(compareVersions)[0];
    if (!next) break;
    version = next;
  }
  return version;
}

/** The planner snapshot from live state. Each probe fails open to null and is named in `unmeasured`. */
export async function liveNextActionState(roots: LiveRoots, now: Date): Promise<NextActionState> {
  const nowMs = now.getTime(); const unmeasured: string[] = [];
  let version: string | null = null; let cells: NaCell[] | null = null;
  try {
    const { listChecklist } = await import('../release-loop/checklist.js');
    const { releaseLedgerRoot } = await import('../instance/resolve.js');
    version = await versionInPlay(join(roots.seatState, '..'), releaseLedgerRoot());
    cells = listChecklist(version, releaseLedgerRoot()).items.map(i => ({ id: i.id, title: i.title, status: i.status, ...(i.owner ? { owner: i.owner } : {}),
      ...(i.priority ? { priority: i.priority } : {}), ...(i.predecessors ? { predecessors: i.predecessors } : {}), ...(i.doneCriterion ? { doneCriterion: i.doneCriterion } : {}),
      ...(i.source ? { source: i.source } : {}), ...(i.body ? { body: i.body } : {}), ...(i.evidence ? { evidence: i.evidence } : {}),
      ...(i.dispatchKind ? { dispatchKind: i.dispatchKind } : {}), updatedAt: i.updatedAt }));
  } catch (e) { unmeasured.push(`cells(${short(e)})`); }
  let hands: NaHand[] | null = null;
  try {
    const { liveHandPool } = await import('../seat/hand-pool-live.js');
    const { isJudgeHand } = await import('../seat/hand-pool.js');
    hands = (await liveHandPool({ now: nowMs })).map(h => ({ seat: h.seat, home: h.home, state: h.state, ...(h.since !== undefined ? { since: h.since } : {}), ...(isJudgeHand(h.seat) ? { judge: true } : {}),
      ...(h.ownerIdle && h.cell ? { ownerIdleCell: h.cell } : {}) }));
  } catch (e) { unmeasured.push(`hands(${short(e)})`); }
  let directives: NaDirective[] | null = null; let handRaises: NaHandRaise[] | null = null;
  let holds: NaHold[] = []; let unacked: NonNullable<NextActionState['unacked']> = [];
  try {
    const { openMsgStoreReadOnly } = await import('../msg/msg-store.js');
    const store = openMsgStoreReadOnly();
    try {
      directives = store.listCreatedBetween(new Date(nowMs - DIRECTIVE_LOOKBACK_MS).toISOString(), new Date(nowMs + 1000).toISOString())
        .filter(m => m.to.toUpperCase() === 'OP' && (m.kind === 'mission' || (!!m.crownDirective && !NOT_WORK_KINDS.has(m.kind ?? ''))))
        .map(m => ({ msgId: m.id, crownDirective: m.crownDirective ?? null, kind: m.kind ?? null, from: m.from, body: m.body, createdAt: m.createdAt }));
      try {
        const ladder = await import('../msg/hand-raise-ladder.js');
        let fed: ReturnType<typeof ladder.loadFederationLadder> | undefined;
        try { fed = ladder.loadFederationLadder({}); } catch { fed = undefined; }
        handRaises = ladder.openHands(store, { now: nowMs, ...(fed ? { ladder: fed } : {}), involving: 'OP' })
          .filter(h => h.receiver.toUpperCase() === 'OP')
          .map(h => ({ msgId: h.id, seat: h.blockedSeat, line: h.body, ageMin: Math.round(h.waitedMs / 60_000), ceoOnly: ladder.isCeoOnlyHand(h) }));
        // FEDERATION MAIL WATCH: hands frozen behind a coordinator broadcast · unacked mail per seat.
        try {
          const watch = await import('../msg/hand-escalation-step.js');
          if (fed) holds = watch.broadcastHolds(store, { ladder: fed, nowMs }).map(h => ({ coordinator: h.coordinator, msgId: h.msgId, at: h.at, frozen: h.frozen, scoped: h.scoped, body: h.body }));
          unacked = watch.unackedBySeat(store, nowMs);
        } catch (e) { unmeasured.push(`mail-watch(${short(e)})`); }
      } catch (e) { unmeasured.push(`hand-raises(${short(e)})`); }
    } finally { store.close(); }
  } catch (e) { unmeasured.push(`msg(${short(e)})`); }
  let releases: NaRelease[] | null = null; let released: string | null = null;
  try {
    const { listSchedules } = await import('../release-loop/release-schedule.js');
    const { isPublishedVersion, compareVersions } = await import('../ops-dashboard/current-version.js');
    const rows = listSchedules();
    released = rows.map(s => s.version).filter(v => { try { return isPublishedVersion(v); } catch { return false; } }).sort(compareVersions).pop() ?? null;
    releases = rows.map(s => ({ version: s.version, cutAt: s.cutAt ?? null, publishAt: s.publishAt ?? null, hasRun: existsSync(join(roots.stateRoot, 'release-graph', s.version, 'state.json')) }));
  } catch (e) { unmeasured.push(`releases(${short(e)})`); }
  return { now: now.toISOString(), version, released, cells, hands, directives, dismissed: readDismissed(roots.stateRoot), handRaises,
    holds, unacked,
    land: readLand(roots.stateRoot, nowMs), releases, bulletin: readBulletin(roots.seatState, nowMs), splitRequests: readSplitRequests(roots.stateRoot, nowMs), unmeasured,
    forced: readForced(enforcePaths(roots.stateRoot).forced, now).map(f => ({ key: f.key, reason: f.reason })), pushPolicy: readPushPolicy() };
}

/** THROTTLE-AUDIT: config `op.next` {handMailsPerHour · handMailsPerHand · assignPerPlan}; unreadable = {} (scaled defaults). */
export function readPushPolicy(read: () => unknown = () => (require('../user-config/reader.js') as typeof import('../user-config/reader.js')).getUserConfig()): PushPolicy {
  try {
    const next = (read() as { op?: { next?: unknown } } | null)?.op?.next;
    return next && typeof next === 'object' ? next as PushPolicy : {};
  } catch { return {}; }
}

function cli(args: readonly string[]): string {
  const r = spawnElanousSync(args, { encoding: 'utf8', timeout: 10 * 60_000 }); // Source: a land tick runs ratchet+tsc on the merge result (minutes).
  const out = `${String(r.stdout ?? '')}`.trim(); const err = `${String(r.stderr ?? '')}`.trim();
  if (r.status !== 0) throw new Error(`eln ${args.slice(0, 3).join(' ')} exit ${r.status}: ${(err || out).split('\n').pop()?.slice(0, 160) ?? ''}`);
  return out;
}

/** Live actuators for planner-owned actions. */
export function liveNextActuators(roots: LiveRoots): NextActuators {
  return {
    // OP-PUSH-BUDGET (11-27): no [SEAT-ASSIGN] mail — priorityOrder ⊕ a pull hint; the hand claims on `eln work next`.
    async hint(entries) {
      const { addPullHints } = await import('../steward/space/work-next-cli.js');
      const { effectiveInstanceRoot } = await import('../instance/resolve.js');
      const r = addPullHints(effectiveInstanceRoot(), entries, 'OP', Date.now());
      return `priorityOrder ${r.order.length} · hints ${Object.keys(r.hints).length}`;
    },
    async wake(seat, lines) {
      const { openMsgStore } = await import('../msg/msg-store.js');
      const { wakeRecipient } = await import('./msg-wake.js');
      const { claimSeatWake, defaultWakeLedgerPath } = await import('../seat/wake-ledger.js');
      // SHARED-WAKE-LEDGER: another waker inside its window → no second mail.
      const claim = claimSeatWake(defaultWakeLedgerPath(), { seat, cell: 'op-pull', by: 'OP', atMs: Date.now() });
      if (!claim.ok) return `skipped (${claim.line})`;
      const store = openMsgStore();
      let id: number;
      try { id = store.post({ from: 'OP', to: seat, kind: 'coord', body: `[OP · pull] ${lines.join(' · ')}`, refs: ['op-pull-wake'] }).id; } finally { store.close(); }
      const woke = await wakeRecipient(seat, id, { from: 'OP', kind: 'coord' });
      return `mail #${id} · ${woke.result}${woke.reason ? ` (${woke.reason})` : ''}`;
    },
    async handMailBudget(hourlyCap) {
      const { openMsgStoreReadOnly } = await import('../msg/msg-store.js');
      const { loadFederationLadder } = await import('../msg/hand-raise-ladder.js');
      const ladder = loadFederationLadder();
      const store = openMsgStoreReadOnly();
      try {
        const rows = store.db.query('SELECT recipient FROM msg_messages WHERE sender = ? AND created_at >= ?')
          .all('OP', new Date(Date.now() - 60 * 60_000).toISOString()) as { recipient: string }[];
        const toHands = rows.filter(r => { const d = ladder.depthOf(r.recipient); return d !== 1 && d !== 2 && r.recipient.toUpperCase() !== 'OP'; }).length;
        return Math.max(0, hourlyCap - toHands);
      } finally { store.close(); }
    },
    landTick() {
      const out = cli(['land', 'graph', 'tick', '--json']);
      try { const r = JSON.parse(out) as { mode?: string; landed?: number[]; decisions?: Array<{ action?: string; cls?: string }> };
        const refused = (r.decisions ?? []).filter(d => d.action === 'refuse').map(d => d.cls).filter(Boolean);
        return `tick ${r.mode ?? '?'} · landed ${r.landed?.length ? r.landed.map(n => `#${n}`).join(',') : '0'}${refused.length ? ` · refused ${[...new Set(refused)].join(',')}` : ''}`; }
      catch { return `tick ran (${out.split('\n')[0]?.slice(0, 80) ?? ''})`; }
    },
    releaseRun(version, cutAt, publishAt) {
      cli(['release', 'graph', 'run', version, '--cut-at', cutAt, '--publish-at', publishAt, '--json']);
      return `run ${version} created (release-graph/${version}/state.json ${existsSync(join(roots.stateRoot, 'release-graph', version, 'state.json')) ? 'exists' : 'not yet visible'})`;
    },
    requestSplit(cell, deadline, why) {
      const at = new Date().toISOString();
      appendSplitRequest(roots.stateRoot, { cell, at, deadline, why: why.slice(0, 300), by: 'next-action' });
      return `split request ${cell} until ${deadline}`;
    },
    writeGoals(lines) {
      const p = goalsNowPath(roots.seatState); mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, `# release goals (next-action planner · ${new Date().toISOString()})\n\n${lines.map(l => `- ${l}`).join('\n')}\n`);
      return `${lines.length} goals → ${p}`;
    },
  };
}
