import { PR_LABELS, STALLED_DRAFT_HOURS } from '../github/pr-labels.js';
import { RELEASE_PATH_LABEL } from './release-path-guard.js';

export interface DraftTriagePr {
  number: number;
  title?: string;
  branch: string;
  labels?: readonly string[];
}

export interface DraftTriageInput {
  draft: DraftTriagePr;
  runStatus: string | undefined;
  mergedTwins: readonly DraftTriagePr[];
  ageHours: number;
  liveBranches: ReadonlySet<string>;
}

export type DraftDecision = { action: 'close' | 'keep'; reason: string };

// Labels the sweeper must never close: an approval-waiting state and the human «keep» / release holds (R-PRK3).
// RELGUARD's release-path hold waits for OP approval — a long wait is not «stale» (TC review #23217).
const PROTECTED_LABELS: ReadonlySet<string> = new Set<string>([...PR_LABELS
  .filter((label) => label.sweep.action === 'exclude' || (label.sweep.action === 'none' && (label.axis === 'state' || label.axis === 'addon')))
  .map((label) => label.name), RELEASE_PATH_LABEL]);

const goalId = (branch: string): string | undefined => /(?:^|[-/])goalid-([a-f0-9]+)(?=-|\/|$)/i.exec(branch)?.[1]?.toLowerCase();

export function decideDraft({ draft, runStatus, mergedTwins, ageHours, liveBranches }: DraftTriageInput): DraftDecision {
  const held = draft.labels?.find((label) => PROTECTED_LABELS.has(label));
  if (held) return { action: 'keep', reason: `label:${held}` };
  if (runStatus === 'running' || runStatus === 'probable-running' || (draft.branch && liveBranches.has(draft.branch))) {
    return { action: 'keep', reason: 'live' };
  }
  const lineage = goalId(draft.branch);
  const twin = mergedTwins.find((pr) => pr.number !== draft.number && (
    (draft.title && pr.title === draft.title) || (lineage && goalId(pr.branch) === lineage)
  ));
  if (twin) return { action: 'close', reason: `superseded-by #${twin.number}` };
  if (!runStatus) return Number.isFinite(ageHours) && ageHours >= STALLED_DRAFT_HOURS
    ? { action: 'close', reason: 'stale-unobserved' }
    : { action: 'keep', reason: 'unobserved' };
  if (Number.isFinite(ageHours) && ageHours >= STALLED_DRAFT_HOURS) return { action: 'close', reason: 'stale-ended-run' };
  return { action: 'keep', reason: 'recent' };
}
