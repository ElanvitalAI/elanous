import { expect, test } from 'bun:test';
import { hasPassingEmergencyPublishGate } from './emergency-publish-authorization.js';
import type { GraphContext } from './node-verdict.js';

function context(): GraphContext {
  return { graphId: 'release-loop', runId: 'run-1', nodeId: 'publish',
    input: { version: '0.3.8', previousVersion: '0.3.7', emergencyPublish: { securityFix: true, hotfixCommits: ['b'.repeat(40)] } },
    outputs: {
      'version-release': { commit: 'c'.repeat(40) },
      'emergency-switch': { outcome: 'switch', action: 'switch', eligible: true, promoted: true,
        normalRunId: 'run-1', hotfixCommit: 'b'.repeat(40) },
      'emergency-gate': { outcome: 'ok', verdict: 'pass', ok: true, runId: 'run-1', hotfixCommit: 'b'.repeat(40),
        releaseCommit: 'c'.repeat(40), measuredCommit: 'c'.repeat(40), introduced: 0, preexisting: 0, unclassified: 0,
        gateExitCode: 0, remote: 'aws2', alwaysInclude: 4, alwaysIncludeMissing: [], unmeasured: null,
        changedFiles: ['src/fix.ts'], testFiles: ['src/fix.test.ts'] },
    },
  };
}

test('emergency gate authorizes only its same-run hotfix and release-cut measurement', () => {
  const valid = context();
  expect(hasPassingEmergencyPublishGate(valid)).toBe(true);

  const foreignGateRun = context();
  foreignGateRun.outputs['emergency-gate']!.runId = 'other-run';
  expect(hasPassingEmergencyPublishGate(foreignGateRun)).toBe(false);

  const foreignCut = context();
  foreignCut.outputs['emergency-gate']!.measuredCommit = 'd'.repeat(40);
  expect(hasPassingEmergencyPublishGate(foreignCut)).toBe(false);

  const incompleteMeasure = context();
  incompleteMeasure.outputs['emergency-gate']!.alwaysIncludeMissing = ['scripts/release-loop/release-version.test.ts'];
  expect(hasPassingEmergencyPublishGate(incompleteMeasure)).toBe(false);
});
