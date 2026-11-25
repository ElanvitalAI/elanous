// FEDERATION-HAND-POOL world ([B] · 대표 11-25) — one device for «does `eln work next` move hands across spaces in the
// right order, maker ≠ judge?» Kept out of federation-day-world.ts so the pool proof does not ride that sim's open fails.
// 세 얼굴: 관측 = PoolCaseResult (exit codes · first claim · lends · cross-role claims) · 판단 근거 = the real workNext ·
// 수복 = none (a sim).
import { workNext, type BoardCell } from '../steward/space/work-next.js';

const MIN = 60_000;
// ── FEDERATION-HAND-POOL scenario ([B] · 대표 11-25 «hands move across spaces regardless of home») ───────────────────────
// World: TC board empty · UX leader holds a demo P0 ⊕ 5 P1 cells · JUD holds 4 judge cells · 4 TC hands ⊕ 1 JUD hand idle.
// Every idle hand calls `eln work next` once per 10 min; a claimed cell closes (green) after 30 min and the hand returns
// to the pool (no home lock). REAL code: workNext (in-memory CAS ledger) for both arms.
// before = the home-space rules (#40114 head fab9f4a710): only the caller's own coordinator counts as a board → TC hands
// get exit 3 all day while UX/JUD backlog waits. after = the pool order (P0 any space → home → borrow) with the ladder's
// coordinators and the OP pulse priorityOrder [demo].
export interface PoolCaseResult {
  readonly arm: 'before' | 'after';
  /** Exit codes of the first round of `eln work next` per hand, in seat order. */
  readonly firstRound: Record<string, number>;
  /** The first cell a TC hand claimed (the demo P0 when the pool ranks it). */
  readonly firstTcClaim: string | null;
  readonly tcClaims: number;
  readonly lends: number;
  /** Maker hands that claimed a judge cell or judge hands that claimed a maker cell — must be 0. */
  readonly crossRoleClaims: number;
  readonly exit3Calls: number;
  readonly cellsGreen: number;
  readonly lendRows: readonly string[];
}

export function runPoolCase(arm: 'before' | 'after', hours = 2): PoolCaseResult {
  const t0 = Date.parse('2026-11-25T09:00:00.000Z');
  const scopeOf = (s: string): string => (s.startsWith('TC') ? 'TC' : s.startsWith('UX') ? 'UX' : s.startsWith('JUD') ? 'JUD' : 'OP');
  const coordinators = new Set(['TC', 'UX', 'JUD']);
  const stamp = (m: number): string => new Date(t0 - m * MIN).toISOString();
  const cells = new Map<string, BoardCell & { owner?: string; status: string }>();
  const put = (c: BoardCell): void => { cells.set(c.id, { ...c }); };
  put({ id: 'UX-DEMO-1', title: 'demo onboarding screen', status: 'yellow', owner: 'UX', priority: 'P0', updatedAt: stamp(30) });
  for (let i = 1; i <= 5; i++) put({ id: `UX-P1-${i}`, title: `ux backlog ${i}`, status: 'yellow', owner: 'UX', priority: 'P1', updatedAt: stamp(200 - i) });
  for (let i = 1; i <= 4; i++) put({ id: `JUD-V-${i}`, title: `verdict ${i}`, status: 'yellow', owner: 'JUD', priority: 'P1', updatedAt: stamp(300 - i) });
  const hands = ['TC-H1', 'TC-H2', 'TC-H3', 'TC-H4', 'JUD-H1'];
  const holding = new Map<string, { cell: string; until: number }>();
  const firstRound: Record<string, number> = {};
  let firstTcClaim: string | null = null; let tcClaims = 0; let lends = 0; let crossRole = 0; let exit3 = 0;
  const lendRows: string[] = [];
  for (let now = t0; now < t0 + hours * 60 * MIN; now += 10 * MIN) {
    for (const [seat, h] of [...holding]) if (now >= h.until) { cells.get(h.cell)!.status = 'green'; holding.delete(seat); }
    for (const seat of hands) {
      if (holding.has(seat)) continue;
      const res = workNext(seat, {
        now: () => now, version: '0.3.36', cells: () => [...cells.values()], scopeOf,
        lastActiveMs: () => now,
        ...(arm === 'after' ? { isCoordinator: (s: string) => coordinators.has(s), priorityOrder: () => ['demo'],
          lend: (row: { from: string; to: string; seat: string; cell: string }) => { lends++; lendRows.push(`${row.seat} ${row.from}→${row.to} ${row.cell}`); } } : {}),
        swap: (id, input) => {
          const c = cells.get(id)!;
          if ((c.owner ?? null) !== input.expectedOwner || c.status !== 'yellow') return { outcome: 'lost' };
          c.owner = input.to; return { outcome: 'swapped' };
        },
      });
      if (!(seat in firstRound)) firstRound[seat] = res.code;
      if (res.code === 3) { exit3++; continue; }
      if (res.code !== 0) continue;
      holding.set(seat, { cell: res.cell.id, until: now + 30 * MIN });
      const judgeCell = res.cell.id.startsWith('JUD');
      if (judgeCell !== seat.startsWith('JUD')) crossRole++;
      if (seat.startsWith('TC')) { tcClaims++; firstTcClaim ??= res.cell.id; }
    }
  }
  return { arm, firstRound, firstTcClaim, tcClaims, lends, crossRoleClaims: crossRole, exit3Calls: exit3,
    cellsGreen: [...cells.values()].filter((c) => c.status === 'green').length, lendRows: lendRows.slice(0, 6) };
}
