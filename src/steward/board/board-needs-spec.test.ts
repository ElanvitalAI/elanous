// POOL-PULL-NEEDS-SPEC (0.3.38 P1 · OP 11-27 16:30) — the board steward lists unowned cells without a done-when to OP as
// «needs-spec», once per changed set. Expectations are literal strings (rule 11 — not built from the product's line).
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boardTick, digestPath, type BoardDeps } from './tick.js';
import type { BoardCellIn } from './model.js';

const AT = '2026-11-27T16:00:00Z';
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function rig(cells: BoardCellIn[], requireDoneWhen?: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'board-needs-spec-')); dirs.push(dir);
  const sent: Array<{ to: string; line: string }> = [];
  let clock = Date.parse(AT);
  const d: BoardDeps = {
    dir, live: true, now: () => new Date(clock), version: () => '9.9.9', nextVersion: () => '9.9.10', phase: () => 'build', cells: () => cells,
    hands: () => [], scopeOf: () => 'TC', isCoordinator: (s) => s === 'TC', waitingOn: () => null,
    readOrder: () => ({ order: [] }), writeOrder: () => {}, publishedAt: () => null, resetPhase: () => {}, returnCell: () => false,
    card: (line, to) => { sent.push({ to, line }); },
    ...(requireDoneWhen !== undefined ? { requireDoneWhen: () => requireDoneWhen === true } : {}),
  };
  return { d, sent, dir, tick: () => { clock += 10 * 60_000; return boardTick(d); } };
}

const cell = (id: string, extra: Partial<BoardCellIn> = {}): BoardCellIn => ({ id, title: `cell ${id}`, status: 'yellow', updatedAt: '2026-11-27T10:00:00Z', ...extra });

describe('board steward · needs-spec digest', () => {
  test('lists unowned cells without done-when to OP once; the same set on the next tick is not re-sent; a changed set is', () => {
    const cells = [cell('NS-B'), cell('NS-A', { doneCriterion: '  ' }), cell('OK-1', { doneCriterion: 'focused test green' }),
      cell('HELD', { owner: 'TC-H-1' }), cell('DONE', { status: 'green' }), cell('ASK', { dispatchKind: 'decision' })];
    const w = rig(cells, true);
    const first = w.tick();
    expect(first.needsSpec).toEqual(['NS-A', 'NS-B']);
    expect(w.sent).toEqual([{ to: 'OP', line: '[BOARD 행정관] needs-spec 2: pool cells without a done-when — hands skip them (eln work next). Set one: eln release checklist set <id> --done "<measurable line>" · NS-A · NS-B' }]);
    expect(first.digest.endsWith(' · needs-spec 2')).toBe(true);
    const row = JSON.parse(readFileSync(digestPath(w.dir), 'utf8').trim().split('\n').at(-1)!) as { needsSpec?: string[] };
    expect(row.needsSpec).toEqual(['NS-A', 'NS-B']);
    // same set → nothing new to OP
    w.tick();
    expect(w.sent.length).toBe(1);
    // a new cell without done-when → the changed set goes out once
    cells.push(cell('NS-C'));
    w.tick(); w.tick();
    expect(w.sent.length).toBe(2);
    expect(w.sent[1]!.line.endsWith(' · NS-A · NS-B · NS-C')).toBe(true);
  });

  test('policy false or absent → no needs-spec line and no needsSpec field', () => {
    for (const flag of [false, undefined]) {
      const w = rig([cell('NS-A')], flag);
      const r = w.tick();
      expect([r.needsSpec, w.sent.length, r.digest.includes('needs-spec')]).toEqual([[], 0, false]);
    }
  });

  test('every cell spec\'d → the set clears; a later needs-spec cell is sent again', () => {
    const cells = [cell('NS-A')];
    const w = rig(cells, true);
    w.tick();
    cells[0] = cell('NS-A', { doneCriterion: 'gate green' });
    w.tick();
    cells.push(cell('NS-A2'));
    w.tick();
    expect(w.sent.map((s) => s.line.split(' · ').at(-1))).toEqual(['NS-A', 'NS-A2']);
  });
});
