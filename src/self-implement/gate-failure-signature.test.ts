import { expect, test } from 'bun:test';
import { gateFailureReceipt, gateFailureReceiptLines } from './gate-failure-signature.js';
import type { SelfImplementGateResult } from './orchestrator.js';

const failure = (file: string, name: string, diagnostic = 'error: expect(received).toBe(expected)') =>
  ({ file, name, diagnostic, attribution: 'introduced' as const, baselinePresence: 'present' as const });
const gate = (failures: ReturnType<typeof failure>[]): SelfImplementGateResult => ({
  passed: false, testStepExecuted: true, baselineFailures: failures,
  reflectGateFacts: { introduced: failures.length, preexisting: 0, unknown: 0 },
});

test('introduced failures produce the same receipt regardless of order and diagnostic paths', () => {
  const a = failure('src/a.test.ts', 'src/a.test.ts > A', 'error: expect(/tmp/run-1)');
  const b = failure('src/b.test.ts', 'src/b.test.ts > B', 'error: expect(/tmp/run-2)');
  const first = gateFailureReceipt(gate([a, b]));
  const second = gateFailureReceipt(gate([b, a]));
  expect(first).toEqual(second);
  expect(first?.signature).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(gateFailureReceiptLines(first!)).toEqual([
    `GATE_FAILURE_SIGNATURE=${first!.signature}`,
    `GATE_FAILURE_TESTS=${JSON.stringify(first!.tests)}`,
  ]);
});

test('changed test identity changes the signature', () => {
  expect(gateFailureReceipt(gate([failure('src/a.test.ts', 'A')]))?.signature)
    .not.toBe(gateFailureReceipt(gate([failure('src/a.test.ts', 'B')]))?.signature);
});

test('summary-only, unmeasured, unknown and timeout failures stay unsigned', () => {
  const measured = gate([failure('src/a.test.ts', 'A')]);
  expect(gateFailureReceipt({ ...measured, baselineFailures: undefined })).toBeNull();
  expect(gateFailureReceipt({ ...measured, testStepExecuted: false })).toBeNull();
  expect(gateFailureReceipt({ ...measured, reflectGateFacts: { introduced: 1, preexisting: 0, unknown: 1 } })).toBeNull();
  expect(gateFailureReceipt(gate([failure('src/a.test.ts', 'A', 'test timed out')]))).toBeNull();
  expect(gateFailureReceipt({ ...measured, reflectGateFacts: { introduced: 2, preexisting: 0, unknown: 0 } })).toBeNull();
});
