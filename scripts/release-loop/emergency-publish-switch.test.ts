import { expect, test } from 'bun:test';
import { decideEmergencyPublishSwitch } from './emergency-publish-switch.js';

test('emergency publish switch stays disabled by default for a blocked normal gate', () => {
  expect(decideEmergencyPublishSwitch('release-run-1', 'regression')).toEqual({
    action: 'stay-normal',
    eligible: false,
    promoted: false,
    normalRunId: 'release-run-1',
    hotfixCommit: null,
    reasons: ['emergency-publish-disabled-by-default'],
    evidence: { normalGateOutcome: 'regression' },
  });
});
