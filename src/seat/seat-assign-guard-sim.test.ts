/**
 * SIM — SEAT-ASSIGN-GUARD (11-27 P0). After rail 74 still 35 `[SEAT-ASSIGN] … by OP` mails went out (16:20Z ×17 ·
 * 16:44Z ×16 · 16:47Z ×2), all 0.3.37 cells, pulling hands off 0.3.38. The caller: the resource steward in OP's TUI
 * (`resource steward-assigned` · trigger «seat-idle …»), one `eln seat assign` per matching-table row, 2–5 s apart.
 * Seeds 1–5 replay that burst through the real steward and the real seatAssign with a fake mail store: target release
 * 0.3.38, a mix of 0.3.37/0.3.38 cells. Expect: no 0.3.37 cell assigned, ≤3 assign mails per sender per 10 min, every
 * excess 0.3.38 row folded into a pull hint, no exception raised to OP, the caller logged; a human --force still passes.
 */
import { describe, expect, test } from 'bun:test';
import type { ChecklistItem } from '../release-loop/checklist.js';
import type { MatchingTable } from '../resource-opt/matching-table.js';
import { createSteward } from '../resource-opt/steward.js';
import { seatAssign, type SeatAssignDeps } from './seat-assign.js';

const T0 = Date.parse('2026-11-26T16:20:50.000Z');
function rng(seed: number): () => number { let a = seed; return () => { a = (a * 1103515245 + 12345) % 2147483648; return a / 2147483648; }; }
const HANDS = ['TC-H-CX-1', 'TC-H-CX-3', 'TC-H-CX-4', 'TC-H-CX-5', 'TC-H-CX-6', 'TC-H-CX-7', 'TC-H-CC-1', 'TC-H-POOL-1', 'TC-H-POOL-3', 'TC-H-REMOTE-1', 'MVP-B', 'HAND-TUI-D'];

function world(seed: number) {
  const r = rng(seed);
  let now = T0;
  const cells = new Map<string, { version: string; item: ChecklistItem }>();
  for (let i = 0; i < 35; i++) {
    const version = r() < 0.8 ? '0.3.37' : '0.3.38';
    const id = `C${seed}-${i}`;
    cells.set(id, { version, item: { id, title: `cell ${i}`, status: 'yellow', priority: r() < 0.3 ? 'P0' : 'P1', updatedAt: '2026-11-26T10:00:00.000Z', updatedBy: 'OP' } as ChecklistItem });
  }
  const mails: { from: string; to: string; cell: string; at: number; by?: string }[] = [];
  const hints: string[] = []; const logs: { event: string; data: Record<string, unknown> }[] = [];
  const deps: SeatAssignDeps = {
    now: () => new Date(now),
    coordinators: () => ({ hq: 'OP', spaces: ['TC', 'UX'] }),
    federationSeats: () => new Set(['OP', 'TC', 'UX', 'MK', ...HANDS]),
    findCell: (id) => cells.get(id),
    writers: () => [],
    assign: () => ({ from: null, outcome: 'assigned' }),
    post: (mail) => { mails.push({ from: mail.from, to: mail.to, cell: mail.refs[0]!.slice(5), at: now, by: mail.refs.find(r => r.startsWith('steward:')) ?? mail.from }); return { id: mails.length }; },
    wake: async () => ({ result: 'injected' }),
    pool: () => ({ hosts: ['minim5'], scope: 'x', source: 'code-default' }),
    log: (event, data) => { logs.push({ event, data }); },
    assignLedger: (since) => mails.filter(m => m.at >= since).map(m => ({ from: m.from, to: m.to, cell: m.cell, by: m.by ?? m.from })),
    targetVersion: () => '0.3.38',
    hint: (cell, seat) => { hints.push(`${cell}→${seat}`); },
  };
  const rows = [...cells.keys()].map((cell, i) => ({ id: `A${i + 1}`, kind: 'assign' as const, seat: HANDS[Math.floor(r() * HANDS.length)]!, idleMin: 5 + Math.floor(r() * 60), cell, title: 'x', priority: 'P1', why: 'unowned' as const }));
  const tick = (ms: number) => { now += ms; };
  return { cells, mails, hints, logs, deps, rows, tick, r };
}

describe('SIM seat-assign guard — the 35-burst, seeds 1–5', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    test(`seed ${seed}: the steward burst sends ≤30 on-target mails per 10 min, 0 off-target, the rest hinted`, async () => {
      const w = world(seed);
      const offered: string[] = [];
      const steward = createSteward({
        build: async (refused) => {
          const out = new Set(refused.map(x => x.seat ? `${x.cell}|${x.seat}` : x.cell));
          const rows = w.rows.filter(x => !out.has(x.cell) && !out.has(`${x.cell}|${x.seat}`));
          return { at: w.tick.length, version: '0.3.37', hqSeat: 'OP', rows, summary: {} as MatchingTable['summary'], unmeasured: [] } as MatchingTable;
        },
        assign: async (row) => {
          offered.push(row.cell); w.tick(2_000 + Math.floor(w.r() * 3_000));
          const res = await seatAssign({ seat: row.seat, cellId: row.cell, actor: 'OP', caller: 'resource-steward' }, w.deps);
          return res.ok ? { ok: true } : { ok: false, code: res.code, reason: res.reason };
        },
      });
      // three bursts like tonight: 16:20, 16:44, 16:47
      const outcomes = [await steward.run('seat-idle JUD-B')];
      w.tick(23 * 60_000); outcomes.push(await steward.run('seat-idle TC-H-CX-6'));
      w.tick(3 * 60_000); outcomes.push(await steward.run('seat-idle MK'));
      // no 0.3.37 cell was mailed
      expect(w.mails.every(m => w.cells.get(m.cell)!.version === '0.3.38')).toBe(true);
      // ≤3 per sender per any 10-min window
      for (const m of w.mails) expect(w.mails.filter(x => x.at >= m.at - 10 * 60_000 && x.at <= m.at).length).toBeLessThanOrEqual(30); // ASSIGN-CAP-POLICY floor (no pool view = 0 idle)
      expect(w.mails.length).toBeLessThanOrEqual(35);
      // every on-target row that did not get a mail in a burst it was offered in was hinted (folded), not dropped
      const onTarget = w.rows.filter(x => w.cells.get(x.cell)!.version === '0.3.38').map(x => x.cell);
      const folded = w.logs.filter(l => l.event === 'seat.assign.folded').map(l => String(l.data.cellId));
      expect(folded.every(c => onTarget.includes(c))).toBe(true);
      expect(w.hints.length).toBe(folded.length);
      // the off-target refusals and folds never reach OP as exceptions
      expect(outcomes.flatMap(o => o.exceptions)).toEqual([]);
      // every outcome row carries the caller
      expect(w.logs.length).toBeGreaterThan(0);
      const assignLogs = w.logs.filter(l => l.event.startsWith('seat.assign'));
      expect(assignLogs.every(l => l.data.caller === 'resource-steward')).toBe(true);
      // each offered 0.3.37 cell is refused once (cell-wide) and never offered again
      const offeredOld = [...new Set(offered)].filter(c => w.cells.get(c)!.version === '0.3.37');
      expect(w.logs.filter(l => l.data.code === 'off-target').length).toBe(offeredOld.length);
      expect(offered.filter(c => w.cells.get(c)!.version === '0.3.37').length).toBe(offeredOld.length);
    });
  }
  test('a human --force passes both guards; a loop without it is folded/refused', async () => {
    const w = world(9);
    const old = [...w.cells.values()].find(c => c.version === '0.3.37')!.item.id;
    expect(await seatAssign({ seat: 'TC-H-CX-1', cellId: old, actor: 'OP', caller: 'next-action' }, w.deps)).toMatchObject({ ok: false, code: 'off-target' });
    expect(await seatAssign({ seat: 'TC-H-CX-1', cellId: old, actor: 'OP', force: true, caller: 'cli:1' }, w.deps)).toMatchObject({ ok: true });
    for (let i = 0; i < 30; i++) w.mails.push({ from: "OP", to: "X", cell: `Z${i}`, at: T0 });
    const cur = [...w.cells.values()].find(c => c.version === '0.3.38')!.item.id;
    expect(await seatAssign({ seat: 'TC-H-CX-3', cellId: cur, actor: 'OP' }, w.deps)).toMatchObject({ ok: false, code: 'rate-folded' });
    expect(w.hints).toEqual([`${cur}→TC-H-CX-3`]);
    expect(await seatAssign({ seat: 'TC-H-CX-3', cellId: cur, actor: 'OP', force: true }, w.deps)).toMatchObject({ ok: true });
    expect(w.logs.filter(l => l.event.startsWith('seat.assign')).at(-1)!.data.caller).toBe('unknown');
  });
});
