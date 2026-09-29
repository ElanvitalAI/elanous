import { PR_LABELS, STALLED_DRAFT_HOURS } from '../github/pr-labels.js';

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
const PROTECTED_LABELS: ReadonlySet<string> = new Set<string>(PR_LABELS
  .filter((label) => label.sweep.action === 'exclude' || (label.axis === 'state' && label.sweep.action === 'none'))
  .map((label) => label.name));

const goalId = (branch: string): string | undefined => /(?:^|[-/])goalid-([a-f0-9]+)(?=-|\/|$)/i.exec(branch)?.[1]?.toLowerCase();

export function decideDraft({ draft, runStatus, mergedTwins, ageHours, liveBranches }: DraftTriageInput): DraftDecision {
  const held = draft.labels?.find((label) => PROTECTED_LABELS.has(label));
  if (held) return { action: 'keep', reason: `label:${held}` };
  if (runStatus === 'running' || runStatus === 'probable-running' || (draft.branch && liveBranches.has(draft.branch))) {
    return { action: 'keep', reason: 'live' };
  }
  // A missing assessment never authorizes a close; unknown is the running-run query's non-running classification.
  if (!runStatus) return { action: 'keep', reason: 'unobserved' };   // run status unknown — kept, and said so
  const lineage = goalId(draft.branch);
  const twin = mergedTwins.find((pr) => pr.number !== draft.number && (
    (draft.title && pr.title === draft.title) || (lineage && goalId(pr.branch) === lineage)
  ));
  if (twin) return { action: 'close', reason: `superseded-by #${twin.number}` };
  if (Number.isFinite(ageHours) && ageHours >= STALLED_DRAFT_HOURS) return { action: 'close', reason: 'stale-ended-run' };
  return { action: 'keep', reason: 'recent' };
}
