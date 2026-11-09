import { expect, test } from 'bun:test';
import { GATE_CLOSURE_LAZY_REQUIRE_EXPECTED, runGateClosureLazyRequireSimulation } from './gate-closure-lazy-require-sim.js';

test('GATE-CLOSURE-LAZY-REQUIRE sim keeps CLI-spawn tests and removes only require-only module imports', () => {
  const results = runGateClosureLazyRequireSimulation();
  expect(results).toHaveLength(GATE_CLOSURE_LAZY_REQUIRE_EXPECTED.length);
  expect(results[0]).toMatchObject({
    id: 'function-local-require-module-import-vs-cli-spawn',
    currentFiles: ['test/cli-spawn.test.ts', 'test/module-import.test.ts'],
    proposedFiles: ['test/cli-spawn.test.ts'],
    selectedFiles: ['test/cli-spawn.test.ts'],
    cliSpawnTests: ['test/cli-spawn.test.ts'],
    measured: true,
    fullGate: false,
    selectedReason: 'formal-receipt-radius-proven',
  });
  expect(results[1]).toMatchObject({
    id: 'opaque-lazy-target-keeps-conservative-module-import-radius',
    currentFiles: [],
    proposedFiles: null,
    selectedFiles: null,
    cliSpawnTests: ['test/cli-spawn.test.ts'],
    measured: false,
    fullGate: true,
  });
  expect(results[1]!.selectedReason).toMatch(/^formal-receipt-radius-opaque:/);
  for (const [index, result] of results.entries()) {
    const scenario = GATE_CLOSURE_LAZY_REQUIRE_EXPECTED[index]!;
    expect(result.currentFiles).toEqual(scenario.expectedCurrent);
    expect(result.proposedFiles).toEqual(scenario.expectedProposed);
    expect(result.selectedFiles).toEqual(scenario.expectedSelected);
    expect(result.cliSpawnTests).toEqual(scenario.expectedCliSpawnTests);
    expect(result.measured).toBe(scenario.expectedMeasured);
    expect(result.fullGate).toBe(scenario.expectedFullGate);
  }
});
