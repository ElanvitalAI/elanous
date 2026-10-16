import { describe, expect, test } from 'bun:test';
import { isSteeredShellRejection, REPAIR_PHASE_READ_ONLY_OPS_TOOLS } from './tool-loop-steered-rejection.js';

describe('steered shell rejections', () => {
  test.each(['rejected:ops-ledger-cli', 'rejected:cd'])('recognizes the unexecuted %s refusal', (approvalKey) => {
    expect(isSteeredShellRejection({ exitCode: null, outcome: 'spawn-error', elapsedMs: 0, approvalKey })).toBe(true);
  });

  test.each([
    null,
    'rejected:cd',
    { exitCode: 1, outcome: 'exit', elapsedMs: 0, approvalKey: 'rejected:cd' },
    { exitCode: null, elapsedMs: 0, approvalKey: 'rejected:other' },
    { exitCode: null, elapsedMs: 0, approvalKey: 'rejected:cd-more' },
    { exitCode: undefined, elapsedMs: 0, approvalKey: 'rejected:cd' },
    { exitCode: null, elapsedMs: 1, approvalKey: 'rejected:cd' },
    { exitCode: null, elapsedMs: 0, approvalKey: null },
  ])('does not exempt a real failure or a mismatched result %#', (result) => {
    expect(isSteeredShellRejection(result)).toBe(false);
  });

  test('only the two ledger reads are allowed through repair', () => {
    expect(REPAIR_PHASE_READ_ONLY_OPS_TOOLS).toEqual(['MsgList', 'ChecklistList']);
  });
});
