// RESOURCE-OPT-HOURLY (L1) — the assignment turn cannot end while a matching-table row has neither an action nor a
// reject reason: the gate reopens it (same internal-turn door, cap 3), and the closed table is logged as
// resource.optimize {idle, unowned, assigned, rejected} and shown as one Federation Board line.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssignmentGate, dispositionsOfTurn, readResourceOptRecord, resourceOptBoardLine, writeResourceOptRecord, type ResourceOptRecord } from './assignment-gate.js';
import { createResourceOptScheduler, nextHourlyDue } from './scheduler.js';
import type { MatchingTable } from './matching-table.js';
import type { StartTurnIfIdleOptions, StartTurnIfIdleResult } from '../chat/internal-turn-contract.js';

const AT = Date.parse('2026-11-25T05:05:00.000Z'); // 14:05 KST

const table = (): MatchingTable => ({
  at: AT, version: '0.3.36', hqSeat: 'OP', unmeasured: [],
  summary: { idle: 3, unowned: 2, stalled: 0, prsWithoutReceipt: 1, judgeQueue: 0, judgeOldestMin: null, unmatchedCells: 0, overflow: 0 },
  rows: [
    { id: 'RO-1', kind: 'assign', seat: 'MK', idleMin: 130, cell: 'CELL-A', title: 'a', priority: 'P0', why: 'unowned' },
    { id: 'RO-2', kind: 'assign', seat: 'UX', idleMin: 20, cell: 'CELL-B', title: 'b', priority: 'P1', why: 'unowned' },
    { id: 'RO-3', kind: 'pregate', seat: 'TC', branch: 'tc/x', pr: 40062, head: '99b0dbd9a500', title: 'x' },
  ],
});

const mailPost = (body: string, result: unknown = { ok: true, id: 9001 }) =>
  ({ role: 'tool', toolName: 'RunShell', toolArgs: { command: `eln msg post --from OP --to MK --kind assign --body "${body}"` }, toolResult: result });

function harness(opts: { opens?: boolean } = {}) {
  const prompts: string[] = [];
  const events: Array<[string, Record<string, unknown>]> = [];
  const records: ResourceOptRecord[] = [];
  const gate = createAssignmentGate({
    now: () => AT + 10 * 60_000,
    startTurnIfIdle: (input: string, _o: StartTurnIfIdleOptions): StartTurnIfIdleResult => {
      prompts.push(input);
      return opts.opens === false ? { opened: false, reason: 'NotIdle' } : { opened: true, turnId: `t${prompts.length}` };
    },
    write: (record) => records.push(record),
    log: (event, data) => events.push([event, data]),
  });
  return { gate, prompts, events, records };
}

describe('assignment gate', () => {
  test('a row without an action or reject reason reopens the turn, naming only the open rows', () => {
    const h = harness();
    h.gate.open(table());
    h.gate.noteTurnEnded({ lines: ['assigned MK.'], rows: [mailPost('[RO-1] CELL-A — take it')] });
    expect(h.gate.check()).toEqual({ opened: true, reason: 'rows-open' });
    expect(h.prompts[0]!.split('\n')[0]).toBe('[resource-opt] assignment turn reopened (1/3) — rows without an action or reject reason: RO-2, RO-3');
    expect(h.prompts[0]).toContain('RO-2 assign · UX (idle 20m) ← P1 CELL-B «b» (unowned)');
    expect(h.prompts[0]).not.toContain('RO-1 assign');
    expect(h.records).toEqual([]);
    // the reopened turn closes the rest: one reject line in the reply, one pregate request mail
    h.gate.noteTurnEnded({ lines: ['RO-2 reject: UX is on the demo path until 16:00'], rows: [mailPost('[RO-3] pregate #40062 on its current head')] });
    expect(h.gate.check()).toEqual({ opened: false, reason: 'complete' });
    expect(h.records.length).toBe(1);
    const record = h.records[0]!;
    expect([record.assigned, record.rejected, record.unhandled, record.reopened, record.closedBy]).toEqual([2, 1, 0, 1, 'complete']);
    expect(record.dispositions).toEqual({
      'RO-1': { kind: 'assigned', via: 'RunShell' },
      'RO-2': { kind: 'rejected', reason: 'UX is on the demo path until 16:00' },
      'RO-3': { kind: 'assigned', via: 'RunShell' },
    });
    expect(h.events.find(([event]) => event === 'optimize')![1]).toEqual({ idle: 3, unowned: 2, assigned: 2, rejected: 1, unhandled: 0, rows: 3, reopened: 1, closedBy: 'complete', version: '0.3.36' });
    expect(h.gate.active()).toBeNull();
  });

  test('a mention is not an action: a failed post, a read-only shell call and a bare reply line do not close a row', () => {
    const rows = [
      mailPost('[RO-1] x', { ok: false, error: 'denied' }),
      { role: 'tool', toolName: 'RunShell', toolArgs: { command: 'eln msg list --to OP | grep RO-2' }, toolResult: { exitCode: 0 } },
    ];
    expect([...dispositionsOfTurn(['RO-1', 'RO-2', 'RO-3'], { lines: ['RO-3 will be handled next hour'], rows })]).toEqual([]);
    // a reject needs a reason of at least four characters
    expect([...dispositionsOfTurn(['RO-3'], { lines: ['RO-3 reject: no'], rows: [] })]).toEqual([]);
    // SeatAssign (L2) counts once it exists; a reject inside a mail body is a reject
    const seatAssign = { role: 'tool', toolName: 'SeatAssign', toolArgs: { seat: 'MK', cell: 'CELL-A', note: 'RO-1' }, toolResult: { ok: true } };
    expect(Object.fromEntries(dispositionsOfTurn(['RO-1', 'RO-2'], { lines: [], rows: [seatAssign, mailPost('RO-2 거절: owner returns at 15:00')] }))).toEqual({
      'RO-1': { kind: 'assigned', via: 'SeatAssign' },
      'RO-2': { kind: 'rejected', reason: 'owner returns at 15:00' },
    });
  });

  test('the turn keeps reopening until the cap, then the open rows are recorded as unhandled', () => {
    const h = harness();
    h.gate.open(table());
    for (let round = 1; round <= 3; round += 1) {
      h.gate.noteTurnEnded({ lines: ['checking replies, next check 14:30'], rows: [] });
      expect(h.gate.check()).toEqual({ opened: true, reason: 'rows-open' });
    }
    h.gate.noteTurnEnded({ lines: ['still checking'], rows: [] });
    expect(h.gate.check()).toEqual({ opened: false, reason: 'cap' });
    expect(h.prompts.length).toBe(3);
    expect(h.prompts[2]!.split('\n')[0]).toBe('[resource-opt] assignment turn reopened (3/3) — rows without an action or reject reason: RO-1, RO-2, RO-3');
    expect([h.records[0]!.unhandled, h.records[0]!.closedBy]).toEqual([3, 'cap']);
  });

  test('a busy door does not count as a reopen; the next turn end tries again', () => {
    const h = harness({ opens: false });
    h.gate.open(table());
    h.gate.noteTurnEnded({ lines: [], rows: [] });
    expect(h.gate.check()).toEqual({ opened: false, reason: 'NotIdle' });
    expect(h.gate.active()).not.toBeNull();
    expect(h.records).toEqual([]);
  });

  test('the closed table is one Federation Board line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'resource-opt-'));
    expect(resourceOptBoardLine(readResourceOptRecord(dir))).toBeNull();
    const h = harness();
    h.gate.open(table());
    h.gate.noteTurnEnded({ lines: ['RO-1 reject: MK keeps the homepage', 'RO-2 reject: UX demo path', 'RO-3 reject: TC already queued it'], rows: [] });
    h.gate.check();
    writeResourceOptRecord(dir, h.records[0]!);
    expect(resourceOptBoardLine(readResourceOptRecord(dir))).toBe('⚙ Resource optimize 14:05 — idle 3 · unowned 2 · assigned 0 · rejected 3 · unhandled 0');
    expect(readFileSync(join(dir, 'history.jsonl'), 'utf8').trim().split('\n').length).toBe(1);
  });
});

describe('resource-opt scheduler', () => {
  test('due at the next :05 of the host clock', () => {
    const base = new Date(2026, 10, 25, 14, 3, 0, 0).getTime();
    expect(new Date(nextHourlyDue(base)).getMinutes()).toBe(5);
    expect(nextHourlyDue(base) - base).toBe(2 * 60_000);
    const after = new Date(2026, 10, 25, 14, 5, 0, 0).getTime();
    expect(nextHourlyDue(after) - after).toBe(60 * 60_000);
  });

  test('on demand: the table becomes the turn prompt and the gate opens; an empty table records the hour without a turn', async () => {
    const h = harness();
    const opened: string[] = [];
    const scheduler = createResourceOptScheduler({
      gate: h.gate, gather: async () => table(), now: () => AT,
      startTurnIfIdle: (input) => { opened.push(input); return { opened: true, turnId: 'turn-1' }; },
      setTimer: () => 0, clearTimer: () => {},
    });
    await scheduler.runNow('on-demand');
    expect(opened.length).toBe(1);
    expect(opened[0]!.split('\n')[0]).toBe('[resource-opt] 14:05 hourly resource optimization — matching table from ledgers (no LLM) · release 0.3.36');
    expect(h.gate.active()?.rows.length).toBe(3);
    // a second trigger while the table is open opens nothing
    await scheduler.runNow('on-demand');
    expect(opened.length).toBe(1);

    const empty = harness();
    const quiet = createResourceOptScheduler({ gate: empty.gate, gather: async () => ({ ...table(), rows: [] }), now: () => AT,
      startTurnIfIdle: () => { throw new Error('no turn for an empty table'); }, setTimer: () => 0, clearTimer: () => {} });
    await quiet.runNow('hourly');
    expect([empty.records[0]!.closedBy, empty.records[0]!.rows]).toEqual(['empty', 0]);
  });
});
