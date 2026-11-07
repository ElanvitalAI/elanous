import { expect, test } from 'bun:test';
import { simulatePrLandDriftGate } from './pr-land-drift-gate-device.js';

const MAIN = 'b'.repeat(40);
const refusal = '✗ heavy-remote: 원격 게이트 gate-rc-1 · remote: error: main-baseline tsc introduced 2 TypeScript diagnostic(s)';

test('pinned main TSC diagnostics become a typecheck-drift refusal only with matching proof', () => {
  const drift = simulatePrLandDriftGate({ main: MAIN,
    output: `[tsc-main-delta] base=${MAIN} base_rc=1 head=${'a'.repeat(40)} head_rc=1 baseline_errors=3 head_errors=5 new_errors=2\nerror: main-baseline tsc introduced 2 TypeScript diagnostic(s)`, refusal });
  expect(drift).toEqual({ typecheckDrift: 'drift', refusal: 'typecheck-drift' });

  const unrelated = simulatePrLandDriftGate({ main: MAIN,
    output: `[tsc-main-delta] base=${MAIN} base_rc=0 head=${'a'.repeat(40)} head_rc=0 baseline_errors=0 head_errors=0 new_errors=0\n[gate] failed unrelated`, refusal });
  expect(unrelated).toEqual({ typecheckDrift: 'drift-unrelated', refusal: 'other' });

  const unmeasured = simulatePrLandDriftGate({ main: MAIN,
    output: `[tsc-main-delta] base=${'c'.repeat(40)} base_rc=1 head=${'a'.repeat(40)} head_rc=1 baseline_errors=3 head_errors=5 new_errors=2\nerror: main-baseline tsc introduced 2 TypeScript diagnostic(s)`, refusal });
  expect(unmeasured).toEqual({ typecheckDrift: 'drift-unmeasured', refusal: 'other' });
});
