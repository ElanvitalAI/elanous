// Canonical PR label registry: 내부 문서 `MANUAL-pr-kinds-draft-vs-approval-2026-09-27`.
export const IDEA_APPROVAL_LIMIT = 10;
export const IDEA_STALE_DAYS = 7;
export const STALLED_DRAFT_HOURS = 24;
export const CLAIM_IDLE_HOURS = 6;

export type PrLabelAxis = 'state' | 'addon' | 'origin' | 'risk';
export type PrLabelApplier = 'harness' | 'launcher' | 'sweeper' | 'session' | 'human';
export type PrLabelSweep =
  | { action: 'none' }
  | { action: 'mark-stalled'; when: 'run-ended' }
  | { action: 'close'; afterHours?: number }
  | { action: 'exclude' }
  | { action: 'notify'; afterDays: number }
  | { action: 'block-approval' };

export interface PrLabelDefinition {
  readonly name: `elanous:${string}`;
  readonly axis: PrLabelAxis;
  readonly color: string;
  readonly description: string;
  readonly appliedBy: readonly PrLabelApplier[];
  readonly sweep: PrLabelSweep;
}

export const PR_LABELS = [
  { name: 'elanous:running', axis: 'state', color: '1D76DB', description: 'Harness run or session is actively handling a draft PR', appliedBy: ['harness', 'session'], sweep: { action: 'mark-stalled', when: 'run-ended' } },
  { name: 'elanous:stalled', axis: 'state', color: 'D93F0B', description: 'Incomplete draft requiring human attention', appliedBy: ['harness', 'sweeper'], sweep: { action: 'close', afterHours: STALLED_DRAFT_HOURS } },
  { name: 'elanous:idea-approval', axis: 'state', color: '0E8A16', description: 'Completed, ready PR awaiting human approval', appliedBy: ['launcher'], sweep: { action: 'none' } },
  { name: 'elanous:superseded', axis: 'state', color: '6A737D', description: 'Another PR has already merged the same work', appliedBy: ['sweeper', 'session'], sweep: { action: 'close' } },
  { name: 'elanous:keep', axis: 'addon', color: 'BFDADC', description: 'Human requested that the PR be kept open', appliedBy: ['human'], sweep: { action: 'exclude' } },
  { name: 'elanous:release-hold', axis: 'addon', color: 'D4C5F9', description: 'Exclude from release notes until verified in production', appliedBy: ['launcher', 'session', 'human'], sweep: { action: 'none' } },
  { name: 'elanous:idea-stale', axis: 'addon', color: 'FBCA04', description: 'Approval pending beyond the notification threshold', appliedBy: ['sweeper'], sweep: { action: 'notify', afterDays: IDEA_STALE_DAYS } },
  { name: 'elanous:needs-rebase', axis: 'addon', color: 'E99695', description: 'Approval blocked by conflicts or failing checks', appliedBy: ['sweeper'], sweep: { action: 'block-approval' } },
  { name: 'elanous:from-harness', axis: 'origin', color: 'C5DEF5', description: 'Launched from a harness goal', appliedBy: ['harness'], sweep: { action: 'none' } },
  { name: 'elanous:from-intake', axis: 'origin', color: 'C5DEF5', description: 'Launched from an absorbed idea', appliedBy: ['launcher'], sweep: { action: 'none' } },
  { name: 'elanous:from-linear', axis: 'origin', color: 'C5DEF5', description: 'Launched from a Linear task', appliedBy: ['launcher'], sweep: { action: 'none' } },
  { name: 'elanous:from-asana', axis: 'origin', color: 'C5DEF5', description: 'Launched from an Asana task', appliedBy: ['launcher'], sweep: { action: 'none' } },
  { name: 'elanous:from-jira', axis: 'origin', color: 'C5DEF5', description: 'Launched from a Jira task', appliedBy: ['launcher'], sweep: { action: 'none' } },
  { name: 'elanous:from-mission', axis: 'origin', color: 'C5DEF5', description: 'Launched from the mission fabric', appliedBy: ['launcher'], sweep: { action: 'none' } },
  { name: 'elanous:from-agent', axis: 'origin', color: 'C5DEF5', description: 'Handed off by another agent', appliedBy: ['launcher'], sweep: { action: 'none' } },
  { name: 'elanous:from-release', axis: 'origin', color: 'C5DEF5', description: 'Launched from the release loop', appliedBy: ['launcher'], sweep: { action: 'none' } },
  { name: 'elanous:from-human', axis: 'origin', color: 'C5DEF5', description: 'Opened by a human', appliedBy: ['human'], sweep: { action: 'none' } },
  { name: 'elanous:risk-security', axis: 'risk', color: 'B60205', description: 'Security-sensitive change', appliedBy: ['launcher', 'human'], sweep: { action: 'none' } },
  { name: 'elanous:risk-public', axis: 'risk', color: 'D93F0B', description: 'Public documentation or release change', appliedBy: ['launcher', 'human'], sweep: { action: 'none' } },
  { name: 'elanous:risk-prod', axis: 'risk', color: 'E99695', description: 'Production configuration change', appliedBy: ['launcher', 'human'], sweep: { action: 'none' } },
] as const satisfies readonly PrLabelDefinition[];

/** Registry order is stable for consumers (including the sync command). */
export function labelsForAxis(axis: PrLabelAxis): readonly (typeof PR_LABELS)[number][] {
  return PR_LABELS.filter((label) => label.axis === axis);
}

/** Unknown labels are not ours to classify; only registered labels participate in cardinality. */
export function validatePrLabels(labels: readonly string[], isDraft: boolean): string[] {
  const errors: string[] = [];
  const names = new Set(labels);
  for (const axis of ['state', 'origin', 'risk'] as const) {
    const count = labelsForAxis(axis).filter((label) => names.has(label.name)).length;
    if (axis === 'risk' ? count > 1 : count !== 1) {
      errors.push(`${axis}: expected ${axis === 'risk' ? 'at most one' : 'exactly one'} label, found ${count}`);
    }
  }
  if (isDraft && names.has('elanous:idea-approval')) {
    errors.push('elanous:idea-approval requires a ready PR (not draft)');
  }
  return errors;
}
