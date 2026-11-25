// SIM-STEWARD-SPACE-FLOOD-1125 — the 행정관 graph (graphs/steward/space.yaml) driven through its REAL node runner
// (src/steward/space/tick.ts r0…x, shadow, temp state root) from two inputs:
//   (1) the SIM-STEWARD-AB-1125 world (federation-steward-ab-world buildWorld · OP + TC + JUD · 12 hands · 20 cells · 15 PRs)
//       at a given second of its hour — panes come from `idleAt` (status.since = the minute a hand went idle);
//   (2) a recorded snapshot (`<state>/steward/space/runs/<runId>.json` → `snapshot`), replayed as raw source output, with
//       optional per-seat «idle since» overrides (els `status.since`, which the recorded snapshot did not keep).
// Output = per-scope action counts ⊕ the exception card each scope would send (lines · total). Shadow only: no mail, no
// assignment, no pregate. The node runner is injectable so the same input can be replayed through another tree's runner
// (before/after measurement).
//
// 세 얼굴: 관측 = counts per scope · card lines · 판단 근거 = real planners (model.ts) on a fixed snapshot ·
//          수복과 인계 = a regression (escalate rows reappear · card over 10 lines) fails the device test.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STEWARD_SPACE_NODES, ledgerPath, runStewardSpaceNode, type StewardEffects, type TickDeps, type TickInput } from '../steward/space/tick.js';
import type { StewardSpaceConfig } from '../steward/space/config.js';
import type { Snapshot } from '../steward/space/model.js';
import type { SnapshotSources } from '../steward/space/sources.js';
import { HANDS, JUD_HANDS, TC_HANDS, T0, type World } from './federation-steward-ab-world.js';

export type SpaceNodeRunner = (node: (typeof STEWARD_SPACE_NODES)[number], input: TickInput, deps: TickDeps) => { outcome: 'ok' | 'fail' };

export interface ScopeOutcome { counts: Record<string, number>; card: { total: number; lines: number } | null }
export type SpaceTickOutcome = Record<string, ScopeOutcome>;

/** Raw source output that rebuilds `snap` through buildSnapshot. `idleSinceMs` (seat → epoch ms it entered idle) feeds
 *  els `status.since`; without it the pane's idle time is the recorded one. */
export function sourcesFromSnapshot(snap: Snapshot, idleSinceMs: Readonly<Record<string, number>> = {}): SnapshotSources {
  const depthOf = (seat: string): number => (seat === snap.hq ? 1 : snap.coordinators.includes(seat) ? 2 : 3);
  return {
    panes: () => ({ panes: snap.seats.map((s) => {
      const recorded = s.idleForMs === null ? null : snap.nowMs - s.idleForMs;
      const since = idleSinceMs[s.seat] ?? recorded;
      return { seat: s.seat, activityState: s.activity, ...(recorded !== null ? { lastEventAtMs: recorded } : { lastEventAtMs: snap.nowMs }),
        status: { state: s.activity.toUpperCase(), ...(since !== null ? { since } : {}) } };
    }) }),
    checklist: () => ({ version: snap.version, items: snap.cells.map((c) => ({ ...c })) }),
    prs: () => snap.prs.map((p) => ({ number: p.number, headRefOid: p.head, headRefName: p.branch, title: p.title, isDraft: p.draft, updatedAt: p.updatedAt,
      ...(p.files ? { files: p.files.map((path) => ({ path })) } : {}) })),
    merged: () => snap.merged.map((m) => ({ number: m.number, headRefName: m.branch, mergedAt: new Date(m.mergedAtMs).toISOString() })),
    receipts: () => [...snap.receipts],
    verdicts: () => [...snap.verdicts],
    util: () => ({ hosts: [...snap.hosts], ageMs: snap.utilAgeMs }),
    ladder: () => ({ hq: snap.hq, parentOf: (seat: string) => snap.parent[seat] ?? snap.hq, depthOf }),
    openHands: () => [...snap.openHands],
  };
}

/** The A/B world at second `atS` of its hour as a steward snapshot: hands idle since their `idleAt` minute, others working. */
export function snapshotFromWorld(world: World, atS: number): Snapshot {
  const nowMs = T0 + atS * 1000;
  const parent: Record<string, string> = { TC: 'OP', JUD: 'OP' };
  for (const h of TC_HANDS) parent[h] = 'TC';
  for (const h of JUD_HANDS) parent[h] = 'JUD';
  const seats = [{ seat: 'OP', activity: 'working', idleForMs: null }, { seat: 'TC', activity: 'working', idleForMs: null }, { seat: 'JUD', activity: 'working', idleForMs: null },
    ...HANDS.map((seat) => {
      const idle = world.idleAt.get(seat);
      return idle !== undefined && idle <= atS ? { seat, activity: 'idle', idleForMs: (atS - idle) * 1000 } : { seat, activity: 'working', idleForMs: null };
    })];
  return {
    nowMs, hq: 'OP', coordinators: ['JUD', 'TC'], parent, seats, version: '0.3.40',
    cells: world.cells.map((c) => ({ id: c.id, title: c.title, status: c.status, ...(c.owner ? { owner: c.owner } : {}), ...(c.priority ? { priority: c.priority } : {}),
      updatedAt: new Date(T0 + (world.cellUpdated.get(c.id) ?? 0) * 1000).toISOString() })),
    prs: world.prs.map((p) => ({ number: p.number, head: p.head, branch: p.branch, title: `cell ${p.number}`, draft: p.draft, updatedAt: new Date(T0).toISOString(), files: [`${p.touches}x.ts`] })),
    merged: [],
    receipts: world.prs.filter((p) => p.receiptAtS !== null && p.receiptAtS <= atS)
      .map((p) => ({ pr: p.number, head12: p.head.slice(0, 12), host: 'minim5', status: 'LIGHT_PASS_NOT_FULL_GATE', atMs: T0 + p.receiptAtS! * 1000 })),
    verdicts: [],
    hosts: [{ host: 'minim5', load1: 4, ncpu: 18, stopped: false }, { host: 'node-b', load1: 8, ncpu: 32, stopped: false }, { host: 'node-c', load1: 2, ncpu: 14, stopped: false }],
    utilAgeMs: 5 * 60_000, openHands: [], sourceErrors: [],
  };
}

const NO_EFFECTS: StewardEffects = {
  mail: () => { throw new Error('shadow sim: mail must not be sent'); },
  assignCell: () => { throw new Error('shadow sim: no assignment'); },
  dispatchPregate: () => { throw new Error('shadow sim: no pregate'); },
  releaseCell: () => { throw new Error('shadow sim: no reclaim'); },
};

/** One shadow tick over every scope of `sources`, through `runNode` (default: this tree's runner). */
export function runSpaceTick(sources: SnapshotSources, nowMs: number, opts: { config?: StewardSpaceConfig; runNode?: SpaceNodeRunner; scopes?: readonly string[] } = {}): SpaceTickOutcome {
  const root = mkdtempSync(join(tmpdir(), 'sim-steward-space-'));
  const runNode = opts.runNode ?? runStewardSpaceNode;
  try {
    const deps: TickDeps = { root, now: () => new Date(nowMs), config: opts.config ?? { pregateHosts: ['minim5', 'node-b', 'node-c'] }, sources: () => sources, effects: NO_EFFECTS };
    const input: TickInput = { runId: `sim-${nowMs}`, shadow: true };
    for (const node of STEWARD_SPACE_NODES) {
      const result = runNode(node, input, deps);
      if (result.outcome !== 'ok') throw new Error(`steward space node ${node} failed`);
    }
    const out: SpaceTickOutcome = {};
    const scopes = opts.scopes ?? collectScopes(root);
    for (const scope of scopes) out[scope] = scopeOutcome(root, scope);
    return out;
  } finally { rmSync(root, { recursive: true, force: true }); }
}

function collectScopes(root: string): string[] {
  try { return readdirSync(join(root, 'steward', 'space'), { withFileTypes: true }).filter((d) => d.isDirectory() && /^[A-Z]/.test(d.name)).map((d) => d.name).sort(); }
  catch { return []; }
}

function scopeOutcome(root: string, scope: string): ScopeOutcome {
  let rows: Array<{ node: string; action: string; reason: string }> = [];
  try { rows = readFileSync(ledgerPath(root, scope), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { /* scope wrote nothing */ }
  const counts: Record<string, number> = {};
  for (const r of rows) if (r.node !== 'x') counts[r.action] = (counts[r.action] ?? 0) + 1;
  const cardRow = rows.find((r) => r.node === 'x');
  const total = cardRow ? Number(/(\d+)건/.exec(cardRow.reason)?.[1] ?? 0) : 0;
  return { counts, card: cardRow ? { total, lines: Math.min(total, 10) } : null };
}

/** A recorded run file (`<state>/steward/space/runs/<runId>.json`) → its snapshot. */
export function recordedSnapshot(path: string): Snapshot {
  return (JSON.parse(readFileSync(path, 'utf8')) as { snapshot: Snapshot }).snapshot;
}
