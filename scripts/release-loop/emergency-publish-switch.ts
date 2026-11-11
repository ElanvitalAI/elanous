/** Run-bound eligibility for the reduced emergency release lane. */

// Source: #36117 — the same release run must remain gate-blocked for two hours.
export const EMERGENCY_PUBLISH_MINIMUM_BLOCKED_MS = 2 * 60 * 60 * 1000;

export interface EmergencyPublishSwitchInput {
  normalRunId: string;
  normalGateOutcome: string;
  securityFix: boolean;
  hotfixCommits: readonly string[];
  blockedSince: string;
  nowMs?: number;
}

export interface EmergencyPublishSwitchDecision {
  action: 'stay-normal' | 'switch';
  eligible: boolean;
  promoted: boolean;
  normalRunId: string;
  hotfixCommit: string | null;
  reasons: string[];
  evidence: { normalGateOutcome: string; securityFix: boolean; hotfixCommitCount: number; blockedMs: number | null; minimumBlockedMs: number };
}

const COMMIT_SHA = /^[0-9a-f]{40}$/i;

export function decideEmergencyPublishSwitch(input: EmergencyPublishSwitchInput): EmergencyPublishSwitchDecision {
  const nowMs = input.nowMs ?? Date.now();
  const blockedSinceMs = Date.parse(input.blockedSince);
  const blockedMs = Number.isFinite(blockedSinceMs) && blockedSinceMs <= nowMs ? nowMs - blockedSinceMs : null;
  const reasons: string[] = [];
  if (!input.normalRunId.trim()) reasons.push('normal-run-id-missing');
  if (!['fail', 'error', 'regression', 'blocked'].includes(input.normalGateOutcome)) reasons.push('normal-release-not-blocked');
  if (input.securityFix !== true) reasons.push('not-a-security-fix');
  if (input.hotfixCommits.length !== 1 || !COMMIT_SHA.test(input.hotfixCommits[0] ?? '')) reasons.push('expected-exactly-one-hotfix-commit');
  if (blockedMs === null) reasons.push('blocked-since-invalid');
  else if (blockedMs < EMERGENCY_PUBLISH_MINIMUM_BLOCKED_MS) reasons.push('normal-release-blocked-too-short');
  const eligible = reasons.length === 0;
  return {
    action: eligible ? 'switch' : 'stay-normal', eligible, promoted: eligible, normalRunId: input.normalRunId,
    hotfixCommit: input.hotfixCommits.length === 1 && COMMIT_SHA.test(input.hotfixCommits[0] ?? '') ? input.hotfixCommits[0]!.toLowerCase() : null,
    reasons,
    evidence: { normalGateOutcome: input.normalGateOutcome, securityFix: input.securityFix,
      hotfixCommitCount: input.hotfixCommits.length, blockedMs, minimumBlockedMs: EMERGENCY_PUBLISH_MINIMUM_BLOCKED_MS },
  };
}
