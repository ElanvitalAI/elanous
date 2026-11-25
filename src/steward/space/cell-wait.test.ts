// cell-wait — when a yellow cell waits on someone else. Expected values are literals.
import { describe, expect, test } from 'bun:test';
import { cellWaitOf, prNamesCell } from './cell-wait.js';

const pr = (over: Partial<{ number: number; head: string; branch: string; title: string; draft: boolean }> = {}) =>
  ({ number: 7, head: 'abcdefabcdef0000', branch: 'tc-h1/x', title: 'fix: thing (CELL-1)', draft: false, ...over });

describe('cell-wait', () => {
  test('the cell id must be a whole token in the title or the branch', () => {
    expect(prNamesCell(pr(), 'CELL-1')).toBe(true);
    expect(prNamesCell(pr({ title: 'fix: CELL-12' }), 'CELL-1')).toBe(false);
    expect(prNamesCell(pr({ title: 'none', branch: 'tc-h1/cell-1-fix' }), 'CELL-1')).toBe(false);
    expect(prNamesCell(pr({ title: 'none', branch: 'tc-h1/cell-1' }), 'CELL-1')).toBe(true);
  });
  test('no receipt → awaiting-receipt · green receipt → awaiting-verdict · PASS → awaiting-land · HOLD → hold', () => {
    expect(cellWaitOf('CELL-1', { prs: [pr()], receipts: [], verdicts: [] })).toBe('awaiting-receipt');
    const green = [{ pr: 7, head12: 'abcdefabcdef', status: 'LIGHT_PASS_NOT_FULL_GATE' }];
    expect(cellWaitOf('CELL-1', { prs: [pr()], receipts: green, verdicts: [] })).toBe('awaiting-verdict');
    expect(cellWaitOf('CELL-1', { prs: [pr()], receipts: green, verdicts: [{ pr: 7, head12: 'abcdefabcdef', kind: 'jud', verdict: 'PASS' }] })).toBe('awaiting-land');
    expect(cellWaitOf('CELL-1', { prs: [pr()], receipts: green, verdicts: [{ pr: 7, head12: 'abcdefabcdef', kind: 'hold', verdict: 'hold' }] })).toBe('hold');
  });
  test('owner work left = not waiting: red receipt · FAIL verdict · draft PR · no PR · verdict on an older head', () => {
    expect(cellWaitOf('CELL-1', { prs: [pr()], receipts: [{ pr: 7, head12: 'abcdefabcdef', status: 'FAIL' }], verdicts: [] })).toBeNull();
    expect(cellWaitOf('CELL-1', { prs: [pr()], receipts: [], verdicts: [{ pr: 7, head12: 'abcdefabcdef', kind: 'jud', verdict: 'FAIL' }] })).toBeNull();
    expect(cellWaitOf('CELL-1', { prs: [pr({ draft: true })], receipts: [], verdicts: [] })).toBeNull();
    expect(cellWaitOf('CELL-1', { prs: [], receipts: [], verdicts: [] })).toBeNull();
    // A PASS on an older head does not count: the new head still needs its receipt.
    expect(cellWaitOf('CELL-1', { prs: [pr()], receipts: [], verdicts: [{ pr: 7, head12: '000000000000', kind: 'jud', verdict: 'PASS' }] })).toBe('awaiting-receipt');
  });
});
