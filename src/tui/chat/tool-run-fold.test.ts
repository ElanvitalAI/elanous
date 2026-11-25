import { expect, test } from 'bun:test';
import { interleavedTurnLines, isToolRunLine, toolActivityLines, toolResultFailed, updateToolActivity, type ToolActivityRow } from './tool-activity.js';

// TOOL-RUN-FOLD (대표 «툴 접기 — Claude 처럼 한 줄»): a run of consecutive tool calls between two text blocks is ONE line from
// the first call; ctrl+o / a click opens the per-call rows. Expectations are literal strings, independent of the renderer.

const done = (id: string, name: string, startedAt: number, finishedAt: number, extra: Partial<ToolActivityRow> = {}): ToolActivityRow =>
  ({ id, name, startedAt, finishedAt, ...extra });
const running = (id: string, name: string, startedAt: number): ToolActivityRow => ({ id, name, startedAt });

test('a finished run of 4 calls renders exactly one line with names counted in first-seen order', () => {
  const rows = [
    done('1', 'CommitmentClose', 0, 100), done('2', 'CommitmentClose', 100, 200),
    done('3', 'ScheduleWakeup', 200, 300), done('4', 'autopilot_set', 300, 400),
  ];
  expect(toolActivityLines(rows, 500)).toEqual(['✓ 4 tools · CommitmentClose ×2 · ScheduleWakeup · autopilot_set']);
});

test('a running run of 3 calls renders exactly one live row with the wall time and the expand hint', () => {
  const rows = [running('g1', 'Grep', 0), running('m', 'MsgList', 0), running('g2', 'Grep', 0)];
  const lines = toolActivityLines(rows, 21_400);
  expect(lines).toHaveLength(1);
  expect(lines).toEqual(['⏺ 3 tools · Grep ×2 · MsgList · 21s (ctrl+o / click to expand)'.replace('⏺', process.platform === 'darwin' ? '⏺' : '●')]);
});

test('the first call already sits on its one line, and the line updates in place as the run grows', () => {
  let rows: ToolActivityRow[] = [];
  rows = updateToolActivity(rows, { phase: 'start', id: 'a', name: 'MsgList' }, 0);
  expect(toolActivityLines(rows, 0)).toHaveLength(1);
  rows = updateToolActivity(rows, { phase: 'finish', id: 'a', name: 'MsgList' }, 50);
  rows = updateToolActivity(rows, { phase: 'start', id: 'b', name: 'ElsControl' }, 60);
  expect(toolActivityLines(rows, 70)).toHaveLength(1);
  rows = updateToolActivity(rows, { phase: 'finish', id: 'b', name: 'ElsControl' }, 80);
  expect(toolActivityLines(rows, 90)).toEqual(['✓ 2 tools · MsgList · ElsControl']);
});

test('a failed call keeps the run line marked ✗ with the failing name', () => {
  let rows: ToolActivityRow[] = [];
  rows = updateToolActivity(rows, { phase: 'start', id: 'a', name: 'Read', target: 'notes.md' }, 0);
  rows = updateToolActivity(rows, { phase: 'finish', id: 'a', name: 'Read' }, 10);
  rows = updateToolActivity(rows, { phase: 'start', id: 'b', name: 'Grep' }, 20);
  rows = updateToolActivity(rows, { phase: 'finish', id: 'b', name: 'Grep', failed: true }, 30);
  rows = updateToolActivity(rows, { phase: 'start', id: 'c', name: 'MsgList' }, 40);
  rows = updateToolActivity(rows, { phase: 'finish', id: 'c', name: 'MsgList' }, 50);
  expect(toolActivityLines(rows, 60)).toEqual(['✗ 3 tools · Read · Grep · MsgList · failed Grep']);
  // Expanded, the failing call's own row carries ✗.
  expect(toolActivityLines(rows, 60, { expanded: true })).toEqual(['✓ Read(notes.md)', '✗ Grep', '✓ MsgList']);
});

test('expanding restores today\'s per-call rows', () => {
  const rows = [
    done('1', 'MsgList', 0, 10), done('2', 'ElsControl', 10, 20),
    done('3', 'Read', 20, 30, { target: 'tool-result-MsgList-438b15007ecf.txt' }), running('4', 'Grep', 0),
  ];
  const folded = toolActivityLines(rows, 1_500);
  expect(folded).toHaveLength(1);
  expect(isToolRunLine(folded[0]!)).toBe(true);
  expect(toolActivityLines(rows, 1_500, { expanded: true })).toEqual([
    '✓ MsgList', '✓ ElsControl', '✓ Read(tool-result-MsgList-438b15007ecf.txt)',
    `${process.platform === 'darwin' ? '⏺' : '●'} Grep 1s`,
  ]);
});

test('text between runs splits them into separate one-line groups', () => {
  const rows = [
    done('a', 'CommitmentClose', 0, 1), done('b', 'CommitmentClose', 1, 2),
    done('c', 'MsgList', 2, 3), done('d', 'ElsControl', 3, 4), done('e', 'Read', 4, 5, { target: 'x.md' }),
  ];
  const text = 'first answer. second answer.';
  const offsets = new Map([['a', 0], ['b', 0], ['c', 14], ['d', 14], ['e', 14]]);
  const lines = interleavedTurnLines(rows, offsets, text, 10, (chunk) => [`TEXT:${chunk.trim()}`]);
  expect(lines).toEqual([
    '✓ 2 tools · CommitmentClose ×2',
    'TEXT:first answer.',
    '✓ 3 tools · MsgList · ElsControl · Read',
    'TEXT:second answer.',
  ]);
});

test('a single call keeps its own row, and a sub-agent stays on its own row between runs', () => {
  expect(toolActivityLines([done('a', 'Read', 0, 10, { target: 'a.ts' })], 20)).toEqual(['✓ Read(a.ts)']);
  const rows = [done('a', 'Read', 0, 1), done('b', 'Grep', 1, 2), done('c', 'Agent', 2, 3), done('d', 'Read', 3, 4), done('e', 'Read', 4, 5)];
  expect(toolActivityLines(rows, 10)).toEqual(['✓ 2 tools · Read · Grep', '✓ Agent', '✓ 2 tools · Read ×2']);
});

test('display only: folding never changes the rows it renders', () => {
  const rows = [done('1', 'Read', 0, 10, { target: 'a.ts' }), done('2', 'Grep', 10, 20, { failed: true }), running('3', 'MsgList', 20)];
  const before = JSON.stringify(rows);
  Object.freeze(rows); rows.forEach((row) => Object.freeze(row));
  toolActivityLines(rows, 100);
  toolActivityLines(rows, 100, { expanded: true });
  interleavedTurnLines(rows, new Map(), '', 100, () => [], { expanded: false });
  expect(JSON.stringify(rows)).toBe(before);
});

test('error-shaped tool results are recognised; ordinary results are not', () => {
  expect(toolResultFailed('Error: no such file')).toBe(true);
  expect(toolResultFailed({ error: 'denied' })).toBe(true);
  expect(toolResultFailed('{"error":"timeout"}')).toBe(true);
  expect(toolResultFailed({ output: 'ok' })).toBe(false);
  expect(toolResultFailed('all good')).toBe(false);
  expect(toolResultFailed({ error: null })).toBe(false);
});
