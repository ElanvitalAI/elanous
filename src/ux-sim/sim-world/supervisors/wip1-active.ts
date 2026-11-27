// Isolated stateful fixture adapted from the existing seat-assign-wip1 tests; production seatAssign decides activity.
import type { ChecklistItem } from '../../../release-loop/checklist.js';
import type { HandPoolEntry } from '../../../seat/hand-pool.js';
import { seatAssign, type SeatAssignDeps } from '../../../seat/seat-assign.js';
import type { Wip1Policy } from '../../../seat/seat-assign-wip1.js';
import type { SimWorldScenario, SimWorldScenarioContext, SimWorldScenarioOutcome } from '../types.js';

const T0 = Date.parse('2026-11-27T03:10:00.000Z');
const POLICY: Wip1Policy = { activeWindowMs: 180 * 60_000, priorityOrder: ['P0', 'P1', 'P2'], unrankedAs: 'P2', activeRecentMs: 30 * 60_000, activePanes: ['WORKING', 'WAITING_APPROVAL', 'WAITING_REPLY'] };

function world(hands: readonly string[], cells: readonly { id: string; priority: 'P0' | 'P1' | 'P2'; owner?: string; ageMin?: number }[],
  opts: { panes?: Map<string, string>; activity?: Map<string, { atMin: number; signal: string }>; activityThrows?: boolean } = {}) {
  let now = T0;
  const panes = opts.panes ?? new Map<string, string>();
  const board = new Map<string, ChecklistItem>();
  for (const c of cells) {
    board.set(c.id, { id: c.id, title: c.id, status: 'yellow', priority: c.priority, ...(c.owner ? { owner: c.owner } : {}),
      updatedAt: new Date(T0 - (c.ageMin ?? 5) * 60_000).toISOString(), updatedBy: 'OP' } as ChecklistItem);
  }
  const history: { cell: string; to: string | null }[] = [];
  const logs: { event: string; data: Record<string, unknown> }[] = [];
  const returns: { cell: string; reason: string }[] = [];
  let mailId = 0;
  const pool = (): HandPoolEntry[] => hands.map(seat => {
    const held = [...board.values()].find(c => c.status === 'yellow' && c.owner === seat);
    const pane = panes.get(seat);
    return held ? { seat, home: 'TC', state: 'working', scope: 'TC', cell: held.id, lent: false, closeCandidate: false, ...(pane ? { pane } : {}) }
      : { seat, home: 'TC', state: 'idle', lent: false, closeCandidate: false, since: T0 - hands.indexOf(seat) * 1_000, ...(pane ? { pane } : {}) };
  });
  const deps: SeatAssignDeps = {
    now: () => new Date(now),
    coordinators: () => ({ hq: 'OP', spaces: ['TC'] }),
    federationSeats: () => new Set(['OP', 'TC', ...hands]),
    findCell: id => { const item = board.get(id); return item ? { version: '0.3.38', item } : undefined; },
    writers: () => [],
    assign: (_v, id, seat) => {
      const item = board.get(id)!;
      const from = item.owner ?? null;
      board.set(id, { ...item, owner: seat, updatedAt: new Date(now).toISOString() });
      history.push({ cell: id, to: seat });
      return { from, outcome: from === seat ? 'same' : 'assigned' };
    },
    post: () => ({ id: ++mailId }),
    wake: async () => ({ result: 'injected' }),
    pool: () => ({ hosts: ['node-b'], scope: 'x', source: 'code-default' }),
    handPool: () => pool(),
    log: (event, data) => { logs.push({ event, data }); },
    targetVersion: () => '0.3.38',
    heldCells: () => [...board.values()],
    wip1Policy: () => POLICY,
    cellActivity: (_seat, id, sinceMs) => {
      if (opts.activityThrows) throw new Error('gh down');
      const a = opts.activity?.get(id);
      return a && T0 - a.atMin * 60_000 >= sinceMs ? { atMs: T0 - a.atMin * 60_000, signal: a.signal } : null;
    },
    returnToBoard: (id, reason) => {
      const item = board.get(id)!;
      board.set(id, { ...item, owner: undefined } as ChecklistItem);
      history.push({ cell: id, to: null });
      returns.push({ cell: id, reason });
      return { ok: true, line: `veto ${id}: unassigned ${item.owner} (back to the board)` };
    },
  };
  const activeOf = (seat: string) => [...board.values()].filter(c => c.status === 'yellow' && c.owner === seat && now - Date.parse(c.updatedAt) <= POLICY.activeWindowMs);
  return { board, history, logs, returns, deps, activeOf, panes, tick: (ms: number) => { now += ms; }, now: () => now };
}


async function run(ctx: SimWorldScenarioContext): Promise<SimWorldScenarioOutcome> {
  const recentMinutes = 1 + Math.floor(ctx.random() * 20);
  const held = [{ id: 'LOW', priority: 'P1' as const, owner: 'TC-H-1', ageMin: 60 }, { id: 'HIGH', priority: 'P0' as const }];
  const active = world(['TC-H-1', 'TC-H-2'], held, { activity: new Map([['LOW', { atMin: recentMinutes, signal: 'commit' }]]) });
  const refusal = await seatAssign({ seat: 'TC-H-1', cellId: 'HIGH', actor: 'OP' }, active.deps);
  const normal = world(['TC-H-1', 'TC-H-2'], held);
  const accepted = await seatAssign({ seat: 'TC-H-1', cellId: 'HIGH', actor: 'OP' }, normal.deps);
  const observed = { seed: ctx.seed, recentMinutes, refusal, activeOwners: [...active.board.values()].map(c => [c.id, c.owner ?? null]), activeHistory: active.history, normalOk: accepted.ok, normalOwners: [...normal.board.values()].map(c => [c.id, c.owner ?? null]), normalHistory: normal.history, normalReturns: normal.returns };
  ctx.recorder.event('wip1-active', observed);
  if (refusal.ok || refusal.code !== 'wip-1' || refusal.suggest !== 'TC-H-2' || refusal.reason !== `seat assign: WIP-1: TC-H-1 actively on LOW (P1 · commit ${recentMinutes}m ago) — HIGH (P0) does not displace it; suggest TC-H-2 (idle · TC pool): eln seat assign TC-H-2 HIGH` || active.history.length !== 0 || active.board.get('LOW')?.owner !== 'TC-H-1' || active.board.get('HIGH')?.owner) return { ok: false, reason: 'active-displaced', diff: JSON.stringify(observed) };
  if (!accepted.ok || normal.board.get('LOW')?.owner || normal.board.get('HIGH')?.owner !== 'TC-H-1' || normal.returns.length !== 1 || normal.returns[0]?.cell !== 'LOW') return { ok: false, reason: 'inactive-not-preempted', diff: JSON.stringify(observed) };
  return { ok: true };
}
export const simWorldScenarios: readonly SimWorldScenario[] = [{ id: 'SUP-WIP1-ACTIVE', title: 'recent activity blocks P0 displacement; inactive lower cell returns to board', run }];
