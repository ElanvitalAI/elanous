import { expect, test } from 'bun:test';
import { decideEmergencyPublishSwitch, EMERGENCY_PUBLISH_MINIMUM_BLOCKED_MS } from './emergency-publish-switch.js';

const commit = 'a'.repeat(40);
const nowMs = Date.parse('2026-11-09T04:00:00.000Z');
const input = (overrides: Partial<Parameters<typeof decideEmergencyPublishSwitch>[0]> = {}) => ({
  normalRunId: 'release-run-1', normalGateOutcome: 'regression', securityFix: true, hotfixCommits: [commit],
  blockedSince: new Date(nowMs - EMERGENCY_PUBLISH_MINIMUM_BLOCKED_MS).toISOString(), nowMs, ...overrides,
});

test('selects the live emergency lane after one security hotfix and two hours of same-run gate blocking', () => {
  expect(decideEmergencyPublishSwitch(input())).toMatchObject({ action: 'switch', eligible: true, promoted: true,
    normalRunId: 'release-run-1', hotfixCommit: commit,
    evidence: { blockedMs: EMERGENCY_PUBLISH_MINIMUM_BLOCKED_MS, hotfixCommitCount: 1 } });
});

test('stays on normal lane when the gate is not blocked, the fix is not security-related, or evidence is ambiguous', () => {
  expect(decideEmergencyPublishSwitch(input({ normalGateOutcome: 'ok' })).reasons).toContain('normal-release-not-blocked');
  expect(decideEmergencyPublishSwitch(input({ securityFix: false })).reasons).toContain('not-a-security-fix');
  expect(decideEmergencyPublishSwitch(input({ hotfixCommits: [commit, 'b'.repeat(40)] })).reasons).toContain('expected-exactly-one-hotfix-commit');
});

test('does not switch before the two-hour block or when the blocked timestamp is invalid', () => {
  expect(decideEmergencyPublishSwitch(input({ blockedSince: new Date(nowMs - EMERGENCY_PUBLISH_MINIMUM_BLOCKED_MS + 1).toISOString() })).reasons)
    .toContain('normal-release-blocked-too-short');
  expect(decideEmergencyPublishSwitch(input({ blockedSince: 'invalid' })).reasons).toContain('blocked-since-invalid');
});
