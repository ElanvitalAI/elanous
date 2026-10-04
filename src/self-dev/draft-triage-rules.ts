import { PR_LABELS, STALLED_DRAFT_HOURS } from '../github/pr-labels.js';
import { RELEASE_PATH_LABEL } from './release-path-guard.js';

export interface DraftTriagePr {
  number: number;
  title?: string;
  branch: string;
  labels?: readonly string[];
  body?: string;
  mergeCommitMessage?: string;
  landingVerifiedComments?: readonly string[];
  createdAt?: string;
  mergedAt?: string;
  changedFiles?: readonly string[];
  /** Latest change to each draft file, from the draft branch's commit history. Missing is not creation time. */
  latestFileChanges?: Readonly<Record<string, string>>;
}

export interface DraftTriageInput {
  draft: DraftTriagePr;
  runStatus: string | undefined;
  mergedTwins: readonly DraftTriagePr[];
  openDrafts?: readonly DraftTriagePr[];
  ageHours: number;
  liveBranches: ReadonlySet<string>;
  /** false only when the current run's final result has actually been checked and ruled out. */
  finalRunResult?: boolean;
}

export type DraftDecision = { action: 'close' | 'keep'; reason: string };

// Labels the sweeper must never close: an approval-waiting state and the human «keep» / release holds (R-PRK3).
// RELGUARD's release-path hold waits for OP approval — a long wait is not «stale» (TC review #23217).
const PROTECTED_LABELS: ReadonlySet<string> = new Set<string>([...PR_LABELS
  .filter((label) => label.sweep.action === 'exclude' || (label.sweep.action === 'none' && (label.axis === 'state' || label.axis === 'addon')))
  .map((label) => label.name), RELEASE_PATH_LABEL]);

const goalId = (branch: string): string | undefined => /(?:^|[-/])goalid-([a-f0-9]+)(?=-|\/|$)/i.exec(branch)?.[1]?.toLowerCase();
export const branchStem = (branch: string): string | undefined => /^self-impl\/(.+)-[a-f0-9]{8}-r[a-f0-9]+$/i.exec(branch)?.[1];
const slot = (body?: string): string | undefined => /^칸:\s*(.+?)\s*$/m.exec(body ?? '')?.[1];
const referencesDraft = (text: string, number: number): boolean =>
  new RegExp(`(?:\\(수확\\s*#${number}\\s*\\)|\\bsuperseded\\s*#${number}(?!\\d))`, 'i').test(text);
const landingCommentReferencesDraft = (text: string, number: number): boolean =>
  new RegExp(`\\blanding-verified\\s*:\\s*(?:draft|superseded|수확)\\s*#${number}(?!\\d)\\b`, 'i').test(text);

export function decideDraft({ draft, runStatus, mergedTwins, openDrafts, ageHours, liveBranches, finalRunResult }: DraftTriageInput): DraftDecision {
  const held = draft.labels?.find((label) => PROTECTED_LABELS.has(label));
  if (held) return { action: 'keep', reason: `label:${held}` };
  if (runStatus !== 'self-implement.result final' && draft.branch && liveBranches.has(draft.branch)
    && finalRunResult === undefined && runStatus !== 'running' && runStatus !== 'probable-running') {
    return { action: 'keep', reason: 'branch-finality-unobserved' };
  }
  if (runStatus === 'running' || runStatus === 'probable-running' ||
    (runStatus !== 'self-implement.result final' && draft.branch && liveBranches.has(draft.branch))) {
    return { action: 'keep', reason: 'live' };
  }
  const lineage = goalId(draft.branch);
  const twin = mergedTwins.find((pr) => pr.number !== draft.number && (
    (draft.title && pr.title === draft.title) || (lineage && goalId(pr.branch) === lineage)
  ));
  if (twin) return { action: 'close', reason: `superseded-by #${twin.number}` };
  const stem = branchStem(draft.branch);
  const createdAt = Date.parse(draft.createdAt ?? '');
  const newer = stem && draft.title && Number.isFinite(createdAt) ? openDrafts
    ?.filter((pr) => pr.number !== draft.number && pr.title === draft.title && branchStem(pr.branch) === stem
      && Number.isFinite(Date.parse(pr.createdAt ?? '')) && Date.parse(pr.createdAt!) > createdAt)
    .sort((a, b) => Date.parse(b.createdAt!) - Date.parse(a.createdAt!) || b.number - a.number)[0] : undefined;
  if (newer) return { action: 'close', reason: `duplicate-of-open #${newer.number}` };
  const harvest = mergedTwins.find((pr) => pr.number !== draft.number && (
    [pr.mergeCommitMessage, pr.body].some((text) => text && referencesDraft(text, draft.number))
    || pr.landingVerifiedComments?.some((text) => landingCommentReferencesDraft(text, draft.number))
  ));
  if (harvest) return { action: 'close', reason: `superseded-by #${harvest.number} (harvest #${draft.number})` };
  const created = Date.parse(draft.createdAt ?? '');
  const files = draft.changedFiles;
  const draftSlot = slot(draft.body);
  const later = mergedTwins.filter((pr) => pr.number !== draft.number && Number.isFinite(created)
    && Number.isFinite(Date.parse(pr.mergedAt ?? '')) && Date.parse(pr.mergedAt!) > created
    && ((lineage && goalId(pr.branch) === lineage) || (draftSlot && slot(pr.body) === draftSlot)));
  if (files?.length && files.every((file) => {
    const changed = Date.parse(draft.latestFileChanges?.[file] ?? '');
    return Number.isFinite(changed) && changed >= created && later.some((pr) =>
      pr.changedFiles?.includes(file) && Date.parse(pr.mergedAt!) > changed);
  })) {
    const covering = later.filter((pr) => pr.changedFiles?.some((file) => files.includes(file)
      && Date.parse(pr.mergedAt!) > Date.parse(draft.latestFileChanges![file]!)));
    return { action: 'close', reason: `superseded-by #${covering.map((pr) => pr.number).join(', #')} (all-files-landed)` };
  }
  if (!runStatus) return Number.isFinite(ageHours) && ageHours >= STALLED_DRAFT_HOURS
    ? { action: 'close', reason: 'stale-unobserved' }
    : { action: 'keep', reason: 'unobserved' };
  if (runStatus === 'self-implement.result final') return Number.isFinite(ageHours) && ageHours >= STALLED_DRAFT_HOURS
    ? { action: 'close', reason: 'stale-ended-run (self-implement.result final; worktree is not live)' }
    : { action: 'keep', reason: 'recent (self-implement.result final; worktree is not live)' };
  if (Number.isFinite(ageHours) && ageHours >= STALLED_DRAFT_HOURS) return { action: 'close', reason: 'stale-ended-run' };
  return { action: 'keep', reason: 'recent' };
}
