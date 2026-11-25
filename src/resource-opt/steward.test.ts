// RESOURCE-OPT-STEWARD — the steward assigns/requests what it can; only refused rows reach OP, once; the idle seat falls
// through to the next cell after a refusal; a seat-idle event runs it after 5 min. Literals only (no product constants).
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMatchingTable, type MatchingInput, type MatchingTable } from './matching-table.js';
import { createSteward, formatExceptionPrompt } from './steward.js';
import { parseSeatAssignOutput } from './steward-live.js';
import { createResourceOptScheduler } from './scheduler.js';
import { createSeatIdleSignal, readSeatIdleEvent } from './seat-idle-trigger.js';
import type { AssignmentGate } from './assignment-gate.js';

const NOW = Date.parse('2026-11-25T05:00:00.000Z');
const base = (over: Partial<MatchingInput> = {}): MatchingInput => ({
  now: NOW, version: '0.3.40', hqSeat: 'OP',
  panes: [{ seat: 'TC-H1', state: 'IDLE', since: NOW - 30 * 60_000 }, { seat: 'TC-H2', state: 'IDLE', since: NOW - 10 * 60_000 }, { seat: 'TC-H3', state: 'BUSY' }],
  cells: [
    { id: 'C12', title: 'p0 unowned (live writer)', status: 'yellow', priority: 'P0', updatedAt: new Date(NOW - 300_000).toISOString() },
    { id: 'C13', title: 'p0 unowned', status: 'yellow', priority: 'P0', updatedAt: new Date(NOW - 120_000).toISOString() },
    { id: 'C14', title: 'p1 unowned', status: 'yellow', priority: 'P1', updatedAt: new Date(NOW - 180_000).toISOString() },
  ],
  prs: [{ number: 50010, headSha: 'abcdef0123456789abcdef0123456789abcdef01', branch: 'tc-h3/cell-10', isDraft: false }],
  greenLanes: [], judgeQueue: [{ id: 'J-1', sinceMs: NOW - 50 * 60_000, pr: 50002 }], ...over,
});

describe('matching fall-through after a refusal', () => {
  test('a cell-wide refusal takes the cell out; the longest-idle seat gets the next cell', () => {
    const rows = buildMatchingTable(base({ refused: [{ cell: 'C12' }] })).rows.filter((r) => r.kind === 'assign');
    expect(rows.map((r) => r.kind === 'assign' ? `${r.seat}<-${r.cell}` : '')).toEqual(['TC-H1<-C13', 'TC-H2<-C14']);
  });
  test('a pair refusal only skips that seat for that cell', () => {
    const rows = buildMatchingTable(base({ refused: [{ cell: 'C12', seat: 'TC-H1' }] })).rows.filter((r) => r.kind === 'assign');
    expect(rows.map((r) => r.kind === 'assign' ? `${r.seat}<-${r.cell}` : '')).toEqual(['TC-H2<-C12', 'TC-H1<-C13']);
  });
  test('without refusals the table is unchanged (P0 first to the longest idle)', () => {
    const rows = buildMatchingTable(base()).rows.filter((r) => r.kind === 'assign');
    expect(rows.map((r) => r.kind === 'assign' ? `${r.seat}<-${r.cell}` : '')).toEqual(['TC-H1<-C12', 'TC-H2<-C13']);
  });
});

function harness(refuse: Record<string, { code: string; reason: string }> = { C12: { code: 'live-writer', reason: 'seat assign: another live writer holds C12' } }) {
  let clock = NOW;
  const owners = new Map<string, string>();
  const calls: string[] = [];
  const mails: string[] = [];
  const steward = createSteward({
    now: () => clock,
    build: async (refused) => buildMatchingTable(base({ now: clock, refused,
      panes: base().panes.map((p) => (p.seat && [...owners.values()].includes(p.seat) ? { seat: p.seat, state: 'BUSY' } : p)),
      cells: base().cells.map((c) => (owners.has(c.id) ? { ...c, owner: owners.get(c.id)!, updatedAt: new Date(clock).toISOString() } : c)) })),
    assign: async (row) => {
      calls.push(`${row.seat}<-${row.cell}`);
      const r = refuse[row.cell];
      if (r) return { ok: false, code: r.code, reason: r.reason };
      owners.set(row.cell, row.seat);
      return { ok: true };
    },
    requestPregate: (row) => { mails.push(`pregate #${row.pr} -> ${row.seat}`); return true; },
    requestJudge: (row) => { mails.push(`judge ${row.cell}`); return true; },
  });
  return { steward, calls, mails, owners, tick: (ms: number) => { clock += ms; } };
}

describe('steward run', () => {
  test('refused C12 → TC-H1 falls through to C13 and TC-H2 to C14; one exception; routine rows mailed, not OP', async () => {
    const h = harness();
    const out = await h.steward.run('cron');
    expect(h.calls).toEqual(['TC-H1<-C12', 'TC-H2<-C13', 'TC-H1<-C14']);
    expect(out.assigned).toEqual([{ seat: 'TC-H2', cell: 'C13' }, { seat: 'TC-H1', cell: 'C14' }]);
    expect(out.exceptions.map((e) => `${e.row.cell}:${e.code}`)).toEqual(['C12:live-writer']);
    expect(h.mails).toEqual(['pregate #50010 -> TC-H3', 'judge J-1']);
    expect(out.unavailable).toBe(false);
    expect(formatExceptionPrompt(out.table!, out.exceptions).split('\n')[0]).toBe('[resource-opt] steward exceptions — 1 assignment the steward could not make (everything else was assigned or requested automatically)');
  });

  test('the same refusal is raised once; routine mails are not repeated', async () => {
    const h = harness();
    await h.steward.run('cron');
    h.tick(10 * 60_000);
    const second = await h.steward.run('cron');
    expect(second.exceptions).toEqual([]);
    expect(h.mails).toEqual(['pregate #50010 -> TC-H3', 'judge J-1']);
  });

  test('SeatAssign not installed → unavailable (the caller falls back to the full table)', async () => {
    const h = harness({ C12: { code: 'unavailable', reason: 'seat assign gave no result (exit 1)' } });
    const out = await h.steward.run('cron');
    expect(out.unavailable).toBe(true);
    expect(out.exceptions).toEqual([]);
  });
});

describe('parseSeatAssignOutput (eln seat assign --json)', () => {
  test('ok · refusal with code · not the JSON result → unavailable', () => {
    expect(parseSeatAssignOutput('{"ok":true,"seat":"TC-H1","cellId":"C13"}\n', 0)).toEqual({ ok: true });
    expect(parseSeatAssignOutput('{"ok":false,"code":"live-writer","reason":"busy path"}', 1)).toEqual({ ok: false, code: 'live-writer', reason: 'busy path' });
    expect(parseSeatAssignOutput("error: unknown command 'assign'", 1)).toEqual({ ok: false, code: 'unavailable', reason: 'seat assign gave no result (exit 1)' });
  });
});

function fakeGate(): AssignmentGate & { opened: MatchingTable[] } {
  const opened: MatchingTable[] = [];
  return { opened, open: (t: MatchingTable) => { opened.push(t); }, active: () => null, expireIfStale: () => {}, recordEmpty: () => {} } as unknown as AssignmentGate & { opened: MatchingTable[] };
}

describe('scheduler with a steward', () => {
  test('exceptions only open the turn; its prompt names only the refused row', async () => {
    const h = harness();
    const gate = fakeGate();
    const prompts: string[] = [];
    const s = createResourceOptScheduler({ gate, gather: async () => { throw new Error('full table must not be gathered'); }, steward: h.steward,
      startTurnIfIdle: (text) => { prompts.push(text); return { opened: true, turnId: 't1' } as never; }, setTimer: () => 0, clearTimer: () => {} });
    await s.runNow('cron');
    expect(gate.opened.map((t) => t.rows.map((r) => r.id))).toEqual([['RX-1']]);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('RX-1 assign · TC-H1');
    expect(prompts[0]).toContain('refused: live-writer');
    expect(prompts[0]).not.toContain('C13');
  });

  test('nothing refused → no turn at all', async () => {
    const h = harness({});
    const gate = fakeGate();
    let starts = 0;
    const s = createResourceOptScheduler({ gate, gather: async () => null, steward: h.steward,
      startTurnIfIdle: () => { starts += 1; return { opened: true, turnId: 't' } as never; }, setTimer: () => 0, clearTimer: () => {} });
    await s.runNow('cron');
    expect(starts).toBe(0);
    expect(gate.opened).toEqual([]);
  });

  test('cadence is 10 min; a seat-idle event runs 5 min after the seat went idle', () => {
    let clock = NOW;
    const timers: Array<{ ms: number; fn: () => void }> = [];
    const runs: string[] = [];
    const steward = { run: async (reason: string) => { runs.push(reason); return { table: null, assigned: [], routine: [], exceptions: [], unavailable: false }; }, refusals: () => [] };
    const s = createResourceOptScheduler({ gate: fakeGate(), gather: async () => null, steward, now: () => clock,
      startTurnIfIdle: () => ({ opened: false, reason: 'NotIdle' }) as never, setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {} });
    s.start();
    expect(s.nextDueAt()).toBe(NOW + 600_000);
    s.noteSeatIdle('tc-h4', NOW - 120_000);
    expect(timers[1]!.ms).toBe(180_000);
    timers[1]!.fn();
    expect(runs).toEqual(['seat-idle TC-H4']);
    clock += 1;
  });
});

describe('seat-idle event file', () => {
  test('a seat writes seat-idle.<SEAT> (throttled 30 s); the reader parses seat and since', () => {
    const dir = mkdtempSync(join(tmpdir(), 'seat-idle-'));
    let clock = 1_000_000;
    const signal = createSeatIdleSignal('tc-h2', { dir, now: () => clock });
    expect(signal()).toBe(true);
    clock += 29_999;
    expect(signal()).toBe(false);
    clock += 1;
    expect(signal()).toBe(true);
    expect(readdirSync(dir).filter((n) => !n.startsWith('.'))).toEqual(['seat-idle.TC-H2']);
    expect(readSeatIdleEvent(dir, 'seat-idle.TC-H2')).toEqual({ seat: 'TC-H2', since: 1_030_000 });
    expect(readSeatIdleEvent(dir, 'trigger')).toBe(null);
  });
});
