import { classifyDestructive, type GuardianFinding } from '../ask-user-question/guardian.js';

export type BashApprovalPolicy = 'dangerous' | 'all';

// Source: match the command-summary cap used by Guardian while keeping approval prompts compact.
export const BASH_APPROVAL_MATCHED_TEXT_LIMIT = 80;

/** Return the policy reason that requires HITL, or null for an ordinary command. */
export function bashApprovalFinding(command: string, policy: BashApprovalPolicy): GuardianFinding | null {
  if (policy === 'all') {
    return { severity: 'destructive', reason: 'all Bash calls require confirmation', matched: command.slice(0, BASH_APPROVAL_MATCHED_TEXT_LIMIT) };
  }
  return classifyDestructive(command);
}
