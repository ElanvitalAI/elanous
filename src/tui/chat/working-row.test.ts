import { expect, test } from 'bun:test';
import { runningToolLabel } from './tool-activity.js';
import {
  SPINNER_FRAME_MS, WORKING_INTERRUPT_HINT, WORKING_SPINNER_FRAMES, formatWorkingElapsed, isWorkingRow, workingRowLine,
  workingSpinnerFrame, workingVerb,
} from './working-row.js';

test('the row reads «<spinner> <verb> (<elapsed> • esc to interrupt)» with an optional queued suffix', () => {
  const row = workingRowLine({ phase: { kind: 'working' }, elapsedMs: 12_000, queued: 0, columns: 80 });
  expect(row).toBe(`${workingSpinnerFrame(12_000)} Working (12s • ${WORKING_INTERRUPT_HINT})`);
  expect(workingRowLine({ phase: { kind: 'thinking' }, elapsedMs: 0, queued: 2, columns: 80 }))
    .toBe(`${workingSpinnerFrame(0)} Thinking (0s • ${WORKING_INTERRUPT_HINT}) · 2 queued`);
  expect(isWorkingRow(row)).toBe(true);
  expect(isWorkingRow('✓ Read(a.ts)')).toBe(false);
  expect(row).not.toMatch(/[가-힣]/u);
});

test('the verb follows the phase: thinking, responding, running tool, default working', () => {
  expect(workingVerb({ kind: 'thinking' })).toBe('Thinking');
  expect(workingVerb({ kind: 'responding' })).toBe('Responding');
  expect(workingVerb({ kind: 'tool', name: 'Read', target: 'herdr-prompt.ts' })).toBe('Running Read(herdr-prompt.ts)');
  expect(workingVerb({ kind: 'tool', name: 'Bash' })).toBe('Running Bash');
  expect(workingVerb({ kind: 'working' })).toBe('Working');
});

test('elapsed is compact and the spinner is a pure function of elapsed time (fake clock, no wall clock)', () => {
  expect(formatWorkingElapsed(0)).toBe('0s');
  expect(formatWorkingElapsed(59_999)).toBe('59s');
  expect(formatWorkingElapsed(65_000)).toBe('1m 05s');
  expect(formatWorkingElapsed(3_723_000)).toBe('1h 02m 03s');
  expect(workingSpinnerFrame(0)).toBe(WORKING_SPINNER_FRAMES[0]);
  expect(workingSpinnerFrame(SPINNER_FRAME_MS)).toBe(WORKING_SPINNER_FRAMES[1]);
  expect(workingSpinnerFrame(SPINNER_FRAME_MS * WORKING_SPINNER_FRAMES.length)).toBe(WORKING_SPINNER_FRAMES[0]);
});

test('a narrow width drops the queued suffix first, then cuts the row; it never exceeds the width', () => {
  const wide = workingRowLine({ phase: { kind: 'responding' }, elapsedMs: 5_000, queued: 3, columns: 80 });
  expect(wide.endsWith('· 3 queued')).toBe(true);
  const tight = workingRowLine({ phase: { kind: 'responding' }, elapsedMs: 5_000, queued: 3, columns: Bun.stringWidth(wide) - 1 });
  expect(tight).not.toContain('queued');
  expect(tight).toContain(`• ${WORKING_INTERRUPT_HINT})`);
  for (const columns of [10, 20, 30]) {
    expect(Bun.stringWidth(workingRowLine({ phase: { kind: 'tool', name: 'Read', target: 'a-very-long-file-name.ts' }, elapsedMs: 5_000, queued: 3, columns }))).toBeLessThanOrEqual(columns);
  }
});

test('the running-tool label uses the same public name and target as the tool rows', () => {
  const rows = [
    { id: 'a', name: 'Read', target: 'done.ts', startedAt: 0, finishedAt: 1 },
    { id: 'b', name: 'Read', target: 'msg-wake.ts', startedAt: 2 },
  ];
  expect(runningToolLabel(rows)).toEqual({ name: 'Read', target: 'msg-wake.ts' });
  expect(runningToolLabel(rows.slice(0, 1))).toBeUndefined();
  // A private tool name never reaches the row.
  expect(runningToolLabel([{ id: 'p', name: 'PRIVATE-tool-diagnostic', startedAt: 0 }])).toEqual({ name: 'Tool' });
});
