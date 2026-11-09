import { expect, test } from 'bun:test';
import { shadowActual, type GateRadiusShadowPlan } from '../../scripts/release-loop/gate-radius-shadow.js';
import { runGateClosureLazyRequireSimulation, GATE_CLOSURE_LAZY_REQUIRE_EXPECTED } from './gate-closure-lazy-require-sim.js';
import { selectFormalReceiptRadiusFallback } from '../../scripts/release-loop/formal-receipt-radius.js';
import type { ClosureTree } from '../../scripts/release-loop/gate-closure.js';

const SHA = 'a'.repeat(40);

function receiptFallback(index: number) {
  const scenario = GATE_CLOSURE_LAZY_REQUIRE_EXPECTED[index]!;
  const files = Object.keys(scenario.files).sort();
  const tree: ClosureTree = { files, preload: scenario.preload ?? [], read: (path) => scenario.files[path] };
  const tests = files.filter((file) => /\.test\.(?:tsx?|jsx?|mts|cts)$/.test(file));
  return selectFormalReceiptRadiusFallback({ priorCommit: SHA, tree, changed: [scenario.changedFile], tests,
    priorFailures: ['test/previous-failure.test.ts > prior failure'],
    priorErrors: ['test/previous-error.test.ts > prior error'] });
}

function shadowPlan(files: readonly string[], proposedFiles: readonly string[]): GateRadiusShadowPlan {
  return {
    schema: 1,
    version: '0.3.8',
    priorCommit: SHA,
    forCommit: SHA,
    proposed: 'partial',
    files: [...files],
    totalTests: 10,
    reason: 'simulation',
    lazyRequireShadow: {
      currentFiles: [...files],
      proposedFiles: [...proposedFiles],
      cliSpawnTests: 1,
      currentTests: files.length,
      proposedTests: proposedFiles.length,
      measured: true,
      reason: 'shadow-comparison-only',
    },
  };
}

test('GATE-CLOSURE-LAZY-REQUIRE sim measures a smaller candidate and detects failures it would omit', () => {
  const result = runGateClosureLazyRequireSimulation()[0]!;
  expect(result.measured).toBe(true);
  expect(result.currentFiles).toEqual(['test/cli-spawn.test.ts', 'test/module-import.test.ts']);
  expect(result.proposedFiles).toEqual(['test/cli-spawn.test.ts']);
  expect(result.proposedFiles!.length).toBeLessThan(result.currentFiles.length);

  const selected = receiptFallback(0);
  expect(selected.reason).toBe('formal-receipt-radius-proven');
  if (!selected.fallback || !result.proposedFiles) throw new Error('measured receipt fallback missing');
  const selectedFiles = selected.fallback.files;
  expect(selectedFiles).toEqual([...result.proposedFiles]);
  expect([...selected.fallback.priorFailures]).toEqual(["test/previous-failure.test.ts > prior failure"]);
  expect([...selected.fallback.priorErrors]).toEqual(["test/previous-error.test.ts > prior error"]);
  const opaque = receiptFallback(1);
  expect(opaque.fallback).toBeNull();
  expect(opaque.reason).toMatch(/^formal-receipt-radius-opaque:/);

  const retainedFailure = shadowActual({
    plan: shadowPlan(result.currentFiles, selectedFiles),
    outcome: 'regression',
    introduced: ['test/cli-spawn.test.ts > cli contract'],
    cutFailures: ['test/cli-spawn.test.ts > cli contract'],
    cutErrors: [],
    cutRc: 1,
    fullSweep: true,
  });
  expect(retainedFailure).toMatchObject({
    fullSweep: true,
    lazyRequireComparison: 'complete',
    lazyRequireMissedFailures: [],
  });

  const omittedFailure = shadowActual({
    plan: shadowPlan(result.currentFiles, selectedFiles),
    outcome: 'regression',
    introduced: ['test/module-import.test.ts > module contract'],
    cutFailures: ['test/module-import.test.ts > module contract'],
    cutErrors: [],
    cutRc: 1,
    fullSweep: true,
  });
  expect(omittedFailure).toMatchObject({
    fullSweep: true,
    lazyRequireComparison: 'complete',
    lazyRequireMissedFailures: ['test/module-import.test.ts > module contract'],
  });
});
