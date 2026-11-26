// STEWARD-RX-CURRENT-PLAN — 11-26 07:2x: 105 cells moved 0.3.36 → 0.3.37 while package.json still said 0.3.36-dev.0;
// SeatAssign read the 0.3.36 board («no cell …») and judge seats were offered as implementers, so OP got RX-1…RX-73.
// Literal expectations only · sim seeds 3 (pane / cell order shuffled per seed).
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCurrentVersion } from '../ops-dashboard/current-version.js';
import { buildMatchingTable, type CellIn, type MatchingInput, type PaneIn } from './matching-table.js';
import { createSteward } from './steward.js';

const NOW = Date.parse('2026-11-26T00:00:00.000Z');
const SEEDS = [1, 2, 3];

function shuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let s = seed * 2654435761 % 4294967296;
  for (let i = out.length - 1; i > 0; i -= 1) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const cell = (id: string): CellIn => ({ id, title: `cell ${id}`, status: 'yellow', priority: 'P0', updatedAt: new Date(NOW - 60_000).toISOString() });
const idle = (seat: string, minutesIdle: number): PaneIn => ({ seat, state: 'IDLE', since: NOW - minutesIdle * 60_000 });
const input = (over: Partial<MatchingInput>): MatchingInput => ({ now: NOW, version: '0.3.37', hqSeat: 'OP', panes: [], cells: [], prs: [], greenLanes: [], judgeQueue: [], ...over });

describe('board version = PLAN status: current (not the package version)', () => {
  for (const seed of SEEDS) {
    test(`seed ${seed}: plan current 0.3.37 · package 0.3.36-dev.0 → SeatAssign gets 0.3.37 and finds the cells`, async () => {
      const hq = mkdtempSync(join(tmpdir(), 'rxcp-')); const ledger = mkdtempSync(join(tmpdir(), 'rxcp-ledger-'));
      try {
        const plans = join(hq, 'seat-state', 'OP', 'plans'); mkdirSync(plans, { recursive: true });
        writeFileSync(join(plans, 'PLAN-0.3.36.md'), '---\nstatus: shipped\n---\n# PLAN-0.3.36 — old\n');
        writeFileSync(join(plans, 'PLAN-0.3.37.md'), '---\nstatus: current\n---\n# PLAN-0.3.37 — moved\n');
        const version = resolveCurrentVersion({ hqRoot: hq, ledgerRoot: ledger, packageVersion: '0.3.36-dev.0' }).version;
        expect(version).toBe('0.3.37');
        const boards: Record<string, string[]> = { '0.3.36': [], '0.3.37': ['MV-1', 'MV-2'] };
        const asked: string[] = [];
        const steward = createSteward({
          now: () => NOW,
          build: async (refused) => buildMatchingTable(input({ version, refused,
            panes: shuffle([idle('TC-H1', 30), idle('TC-H2', 20)], seed), cells: shuffle([cell('MV-1'), cell('MV-2')], seed) })),
          assign: async (row, v) => {
            asked.push(`${row.cell}@${v}`);
            return boards[v]?.includes(row.cell) ? { ok: true } : { ok: false, code: 'unknown-cell', reason: `seat assign: no cell ${row.cell} in ${v}` };
          },
        });
        const out = await steward.run('cron');
        expect(asked.sort()).toEqual(['MV-1@0.3.37', 'MV-2@0.3.37']);
        expect(out.exceptions).toEqual([]);
        expect(out.assigned.map((a) => a.cell).sort()).toEqual(['MV-1', 'MV-2']);
      } finally { rmSync(hq, { recursive: true, force: true }); rmSync(ledger, { recursive: true, force: true }); }
    });
  }
});

describe('judge / review seats are never implementer candidates', () => {
  for (const seed of SEEDS) {
    test(`seed ${seed}: JUD-B · JUD-3 · REVIEW-2 · org role judge (BENCH) excluded; TC-H1 gets the cell`, () => {
      const table = buildMatchingTable(input({
        panes: shuffle([idle('JUD-B', 90), idle('JUD-3', 80), idle('REVIEW-2', 70), idle('BENCH', 60), idle('TC-H1', 5)], seed),
        cells: [cell('MV-1'), cell('MV-2'), cell('MV-3')],
        isJudge: (seat) => seat === 'BENCH',
      }));
      const assigns = table.rows.flatMap((r) => (r.kind === 'assign' ? [`${r.seat}<-${r.cell}`] : []));
      expect(assigns).toEqual(['TC-H1<-MV-1']);
      expect(table.rows.some((r) => r.kind === 'idle' && ['JUD-B', 'JUD-3', 'REVIEW-2', 'BENCH'].includes(r.seat))).toBe(false);
    });
  }
});

describe('one digest per pulse: at most 5 rows · a raised (cell · seat) never again', () => {
  function world(seed: number) {
    const seats = Array.from({ length: 8 }, (_, i) => idle(`TC-H${i + 1}`, 60 - i));
    const cells = Array.from({ length: 8 }, (_, i) => cell(`RF-${i + 1}`));
    let clock = NOW;
    const steward = createSteward({
      now: () => clock,
      build: async (refused) => buildMatchingTable(input({ now: clock, refused, panes: shuffle(seats, seed), cells: shuffle(cells, seed) })),
      assign: async (row) => ({ ok: false, code: 'not-coordinator', reason: `refused ${row.seat}<-${row.cell}` }),
    });
    return { steward, tick: (ms: number) => { clock += ms; } };
  }
  for (const seed of SEEDS) {
    test(`seed ${seed}: 8 refusals → 5 rows in the first digest`, async () => {
      const w = world(seed);
      const out = await w.steward.run('cron');
      expect(out.exceptions.length).toBe(5);
    });
    test(`seed ${seed}: after the refusal TTL (2h) a pair already raised is not raised again`, async () => {
      const w = world(seed);
      const first = await w.steward.run('cron');
      const firstPairs = new Set(first.exceptions.map((e) => `${e.row.cell}|${e.row.seat}`));
      w.tick(3 * 60 * 60_000);
      const second = await w.steward.run('cron');
      expect(second.exceptions.length <= 5).toBe(true);
      expect(second.exceptions.filter((e) => firstPairs.has(`${e.row.cell}|${e.row.seat}`))).toEqual([]);
    });
  }
});
