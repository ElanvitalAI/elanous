import { CLAIM_IDLE_HOURS, PR_LABELS, STALLED_DRAFT_HOURS } from '../github/pr-labels.js';
import { RELEASE_PATH_LABEL } from './release-path-guard.js';

export function draftClaimComment(owner: string, at: Date, note?: string): string {
  return `🔧 처리 중 — owner ${owner} · ${at.toISOString()}${note?.trim() ? ` · ${note.trim()}` : ''}`;
}

export function draftReleaseComment(at: Date, note?: string): string {
  return `🔧 처리 끝 — ${at.toISOString()}${note?.trim() ? ` · ${note.trim()}` : ''}`;
}

/** No timestamp is an observation gap, not an expired claim. */
export function draftClaimState(draft: { labels: readonly string[]; updatedAt?: string }, now: Date): 'claimed' | 'expired' | 'unclaimed' | 'unobserved' {
  if (!draft.labels.includes('elanous:running') || draft.labels.includes('elanous:harvestable')) return 'unclaimed';
  const updated = typeof draft.updatedAt === 'string' ? Date.parse(draft.updatedAt) : NaN;
  if (!Number.isFinite(updated)) return 'unobserved';
  return (now.getTime() - updated) / 3_600_000 < CLAIM_IDLE_HOURS ? 'claimed' : 'expired';
}

/** DRAFT-CLAIM-AUTO-2-FU — 카드에 남은 claim 기록(`draftClaim.at`)이 아직 살아 있나 — `draftClaimState` 와 «같은 창»(CLAIM_IDLE_HOURS)을 쓴다. */
export function draftClaimRecordLive(at: string, now: Date): boolean {
  const updated = Date.parse(at);
  return Number.isFinite(updated) && (now.getTime() - updated) / 3_600_000 < CLAIM_IDLE_HOURS;
}

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
  /** Latest head commit, separate from PR updatedAt (labels/comments also update that). */
  latestCommitAt?: string;
}

export type DraftTriageNextAction = 'close-a' | 'close-c' | 'human';
export type DraftTriageReviewState = 'approved' | 'changes-requested' | 'commented' | 'dismissed' | 'pending' | 'unknown';
export type DraftTriageCheck = { state: 'yes' | 'no' | 'unknown'; evidence: string };
export interface DraftTriageAssessment {
  origin: string | null;
  cellId: string | null;
  cardId: string | null;
  gate: 'pass' | 'fail' | 'unknown';
  review: DraftTriageReviewState;
  cellStatus: 'green' | 'yellow' | 'red' | 'done' | 'unknown';
  nextAction: DraftTriageNextAction;
  checks: Readonly<Record<'provenance' | 'gate' | 'review' | 'cell-complete' | 'cell-status-repository-bound' | 'replacement-landed' | 'newer-same-card' | 'idle-48h' | 'protected' | 'recent-commit' | 'running' | 'owner-confirmed', DraftTriageCheck>>;
  evidence: readonly string[];
}

export interface DraftTriageAssessmentInput {
  draft: DraftTriagePr;
  now: Date;
  runStatus?: string;
  gate?: 'pass' | 'fail';
  review?: DraftTriageReviewState;
  cellStatus?: 'green' | 'yellow' | 'red' | 'done';
  /** Repository identity attached to the cell-status observation, when available. */
  cellStatusRepository?: string;
  /** Repository targeted by this triage request. */
  targetRepository?: string;
  newerSameCellSameCard?: boolean;
  ownerConfirmed?: boolean;
}

const CLOSE_PROTECTED_LABELS = new Set([
  'elanous:running', 'elanous:keep', 'elanous:release-hold', 'elanous:idea-approval',
  'elanous:harvest-claimed', 'triage:land', 'triage:active',
]);
const TRIAGE_TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled', 'abandoned', 'self-implement.result final']);

/** Evidence-first recommendation. Unknown evidence always routes to a person. */
export function assessDraftTriage(input: DraftTriageAssessmentInput): DraftTriageAssessment {
  const { draft, now } = input;
  const originLabels = (draft.labels ?? []).filter((name) => /^elanous:from-[a-z0-9-]+$/.test(name));
  const origin = originLabels.length === 1 ? originLabels[0]! : null;
  const bodyLines = (draft.body ?? '').split(/\r?\n/);
  const cellMarkerLines = bodyLines.filter((line) => /^\s*칸\s*:/.test(line));
  const cellRows = bodyLines.flatMap((line) => {
    const match = /^칸:\s*([^\r\n]*)$/.exec(line);
    return match ? [match[1]!.trim()] : [];
  });
  const cellValues = new Set(cellRows);
  const cellId = cellMarkerLines.length === cellRows.length && cellRows.length > 0 && cellValues.size === 1
    && /^[A-Z][A-Z0-9-]{2,}$/.test(cellRows[0]!) ? cellRows[0]! : null;
  const cardMarkerLines = bodyLines.filter((line) => /^\s*카드\s*:/.test(line));
  const cardRows = bodyLines.flatMap((line) => {
    const match = /^카드:[ \t]*([^\r\n]+)[ \t]*$/.exec(line);
    return match ? [match[1]!.trim()] : [];
  });
  const cardId = cardMarkerLines.length === cardRows.length && cardRows.length > 0
    && cardRows.every((value) => value === cardRows[0])
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{2,}$/.test(cardRows[0]!) ? cardRows[0]! : null;
  const provenance = Boolean(origin && cellId && cardId);
  const latestCommit = Date.parse(draft.latestCommitAt ?? '');
  const clock = now.getTime();
  const ageHours = Number.isFinite(latestCommit) && Number.isFinite(clock) ? (clock - latestCommit) / 3_600_000 : NaN;
  const protectedLabel = (draft.labels ?? []).find((name) => CLOSE_PROTECTED_LABELS.has(name));
  const protectedState = Boolean(protectedLabel);
  const running = input.runStatus === 'running' || input.runStatus === 'probable-running'
    || (draft.labels ?? []).includes('elanous:running');
  const cellComplete = input.cellStatus === 'green' || input.cellStatus === 'done';
  const hasCellStatusRepositoryIdentity = Boolean(input.cellStatusRepository?.trim() && input.targetRepository?.trim());
  const cellStatusRepositoryBound = hasCellStatusRepositoryIdentity
    && input.cellStatusRepository!.trim().toLowerCase() === input.targetRepository!.trim().toLowerCase();
  const releaseCutoff = Number.isFinite(clock) ? (() => {
    const date = new Date(clock);
    const cutoff = new Date(date);
    cutoff.setUTCHours(0, 30, 0, 0); // 09:30 KST
    return clock < cutoff.getTime() ? cutoff.getTime() - 86_400_000 : cutoff.getTime();
  })() : NaN;
  const recentCommit = Number.isFinite(latestCommit) && Number.isFinite(releaseCutoff) && latestCommit > releaseCutoff;
  const runNotRunning = input.runStatus !== undefined && TRIAGE_TERMINAL_RUN_STATUSES.has(input.runStatus) && !running;
  // Closing requires positive evidence that the head predates today's release cutoff.
  // Missing timestamps are unknown, so they cannot authorize a close recommendation.
  const closeEligible = provenance && !protectedState && Number.isFinite(latestCommit) && !recentCommit && runNotRunning;
  const idle48h = Number.isFinite(ageHours) && ageHours >= 48;
  let nextAction: DraftTriageNextAction = 'human';
  if (closeEligible && cellComplete && cellStatusRepositoryBound) nextAction = 'close-a';
  else if (closeEligible && idle48h && input.ownerConfirmed === true) nextAction = 'close-c';

  const checks = {
    provenance: { state: provenance ? 'yes' : 'unknown', evidence: provenance ? `origin=${origin}; cell=${cellId}; card=${cardId}` : '출처·유효 칸·카드 표지가 모두 확인되지 않음' },
    gate: { state: input.gate === undefined ? 'unknown' : input.gate === 'pass' ? 'yes' : 'no', evidence: `gate=${input.gate ?? 'unknown'}` },
    review: { state: input.review === undefined || input.review === 'unknown' ? 'unknown' : input.review === 'approved' ? 'yes' : 'no', evidence: `latest exact-head review=${input.review ?? 'unknown'}` },
    'cell-complete': { state: input.cellStatus && cellStatusRepositoryBound ? (cellComplete ? 'yes' : 'no') : 'unknown', evidence: input.cellStatus ? `cell=${cellId ?? 'unknown'} status=${input.cellStatus}${cellStatusRepositoryBound ? '' : ' (저장소 귀속 미확인)'}` : `칸 상태 미관측${cellId ? ` (${cellId})` : ''}` },
    'cell-status-repository-bound': { state: cellStatusRepositoryBound ? 'yes' : hasCellStatusRepositoryIdentity ? 'no' : 'unknown', evidence: cellStatusRepositoryBound ? `칸 상태 저장소=${input.cellStatusRepository}; 대상 저장소=${input.targetRepository}` : hasCellStatusRepositoryIdentity ? `칸 상태 저장소=${input.cellStatusRepository}; 대상 저장소=${input.targetRepository} (불일치)` : '칸 상태의 대상 저장소 귀속 미확인' },
    'replacement-landed': { state: 'unknown', evidence: '현재 adapter는 같은 칸 병합 PR과 이 초안의 대체 관계를 증명하지 않음; follow-up 필요' },
    'newer-same-card': { state: input.newerSameCellSameCard === undefined ? 'unknown' : input.newerSameCellSameCard ? 'yes' : 'no', evidence: `${input.newerSameCellSameCard === undefined ? '같은 칸·카드 새 draft 관계 미관측' : `same-cell-same-card-newer=${input.newerSameCellSameCard}`}; 관측 표지이며 대체 증거가 아님` },
    'idle-48h': { state: Number.isFinite(ageHours) ? (idle48h ? 'yes' : 'no') : 'unknown', evidence: Number.isFinite(ageHours) ? `head age=${ageHours.toFixed(1)}h` : 'head commit 시각 미관측' },
    protected: { state: protectedState ? 'yes' : 'no', evidence: protectedLabel ? `보호 표지=${protectedLabel}` : '보호 표지 없음' },
    'recent-commit': { state: Number.isFinite(latestCommit) ? (recentCommit ? 'yes' : 'no') : 'unknown', evidence: Number.isFinite(latestCommit) ? `last commit=${draft.latestCommitAt}; cutoff=09:30 KST` : 'head commit 시각 미관측' },
    running: { state: running ? 'yes' : runNotRunning ? 'no' : 'unknown', evidence: running ? `run=${input.runStatus ?? 'elanous:running'}` : runNotRunning ? `종결 run=${input.runStatus}` : `run 상태 미관측${input.runStatus ? ` (${input.runStatus})` : ''}` },
    'owner-confirmed': { state: input.ownerConfirmed === undefined ? 'unknown' : input.ownerConfirmed ? 'yes' : 'no', evidence: input.ownerConfirmed === undefined ? '소유자 출처 미관측' : input.ownerConfirmed ? '고유 카드 또는 활성 claim owner 확인' : '고유 소유자 없음' },
  } satisfies DraftTriageAssessment['checks'];
  const evidence = Object.values(checks).map((check) => check.evidence);
  return { origin, cellId, cardId, gate: input.gate ?? 'unknown', review: input.review ?? 'unknown',
    cellStatus: input.cellStatus ?? 'unknown', nextAction, checks, evidence };
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
export const PROTECTED_LABELS: ReadonlySet<string> = new Set<string>([...PR_LABELS
  .filter((label) => label.sweep.action === 'exclude' || (label.sweep.action === 'none' && (label.axis === 'state' || label.axis === 'addon')))
  .map((label) => label.name), RELEASE_PATH_LABEL]);

const goalId = (branch: string): string | undefined => /(?:^|[-/])goalid-([a-f0-9]+)(?=-|\/|$)/i.exec(branch)?.[1]?.toLowerCase();
export const branchStem = (branch: string): string | undefined => /^self-impl\/(.+)-[a-f0-9]{8}-r[a-f0-9]+$/i.exec(branch)?.[1];
const slot = (body?: string): string | undefined => /^칸:\s*(.+?)\s*$/m.exec(body ?? '')?.[1];
const goalText = (body?: string): string | undefined => /^골:\s*(\S.*?)\s*$/m.exec(body ?? '')?.[1];
// Auto titles name only files («src/harness: harness-queue.ts») — different goals share them, so they never identify a goal.
export const isAutoTitle = (title: string): boolean =>
  /^[\w./-]+:\s*[^\s,]+\.[a-z0-9]+(?:\s*,\s*[^\s,]+\.[a-z0-9]+)*$/i.test(title.trim());

/** Same goal (TC 10-05): ① both carry a goal identifier → compare it ② otherwise exact title ⊕ both harness drafts ⊕ same branch stem, never an auto title ③ else false. */
/** Same goal only when a verified goal identifier matches on both sides (branch goal id, else the body's «골:» line).
 *  Unlike sameGoalPr it never falls back to titles or branch stems — used where a match closes a PR. */
export function sameVerifiedGoal(a: DraftTriagePr, b: DraftTriagePr): boolean {
  const idA = goalId(a.branch), idB = goalId(b.branch);
  if (idA && idB) return idA === idB;
  // Review r7: a branch goal id on only one side cannot be checked against the other — never close on body text then.
  if (idA || idB) return false;
  const textA = goalText(a.body), textB = goalText(b.body);
  return Boolean(textA && textB && textA === textB);
}
export function sameGoalPr(a: DraftTriagePr, b: DraftTriagePr): boolean {
  const idA = goalId(a.branch), idB = goalId(b.branch);
  if (idA && idB) return idA === idB;
  const textA = goalText(a.body), textB = goalText(b.body);
  if (textA && textB) return textA === textB;
  if (!a.title || a.title !== b.title || isAutoTitle(a.title)) return false;
  const stemA = branchStem(a.branch);
  return Boolean(stemA && a.branch.startsWith('self-impl/') && b.branch.startsWith('self-impl/') && stemA === branchStem(b.branch));
}
const referencesDraft = (text: string, number: number): boolean =>
  new RegExp(`(?:\\(수확\\s*#${number}\\s*\\)|\\bsuperseded\\s*#${number}(?!\\d))`, 'i').test(text);
const landingCommentReferencesDraft = (text: string, number: number): boolean =>
  new RegExp(`\\blanding-verified\\s*:\\s*(?:draft|superseded|수확)\\s*#${number}(?!\\d)\\b`, 'i').test(text);

/**
 * Merged PRs that can cover a draft's files (all-files-landed): merged after the draft was created, on the same
 * goal lineage, slot or branch stem. Empty ⇒ all-files-landed cannot fire, so the draft's per-file history is not needed.
 */
export function laterMergedTwins(draft: DraftTriagePr, mergedTwins: readonly DraftTriagePr[]): DraftTriagePr[] {
  const lineage = goalId(draft.branch);
  const draftSlot = slot(draft.body);
  const stem = branchStem(draft.branch);
  const created = Date.parse(draft.createdAt ?? '');
  const compatible = (pr: DraftTriagePr): boolean =>
    !(lineage && goalId(pr.branch) && goalId(pr.branch) !== lineage)
    && !(draftSlot && slot(pr.body) && slot(pr.body) !== draftSlot);
  return mergedTwins.filter((pr) => pr.number !== draft.number && Number.isFinite(created)
    && Number.isFinite(Date.parse(pr.mergedAt ?? '')) && Date.parse(pr.mergedAt!) > created
    && compatible(pr) && ((lineage && goalId(pr.branch) === lineage)
      || (draftSlot && slot(pr.body) === draftSlot) || (stem && branchStem(pr.branch) === stem)));
}

/**
 * DRAFT-ZERO — explicit harvest-deferred marker: the exact PR-metadata key·value a failed run's termination
 * path records when the draft's changes must survive the sweep for harvest. The marker line is
 * `수확보류: harvest-deferred` (body key·value, never a label-registry entry); the value byte-matches the keep reason.
 */
export const HARVEST_DEFERRED_MARKER_KEY = '수확보류';
export const HARVEST_DEFERRED_MARKER_VALUE = 'harvest-deferred';

const HARVEST_DEFERRED_ROW_RE = new RegExp(`^${HARVEST_DEFERRED_MARKER_KEY}:\\s*([^\\r\\n]*)$`);
const HARVEST_DEFERRED_CONFLICT_RE = new RegExp(`^\\s*${HARVEST_DEFERRED_MARKER_KEY}\\s*:`);

/** Verified only when at least one unindented `수확보류:` body line exists and every such line carries exactly the marker value — missing, indented or conflicting lines never verify. */
export function harvestDeferredMarker(body: string | undefined): boolean {
  const lines = (body ?? '').split(/\r?\n/);
  const rows = lines.flatMap((line) => {
    const match = HARVEST_DEFERRED_ROW_RE.exec(line);
    return match ? [match[1]!.trim()] : [];
  });
  return lines.filter((line) => HARVEST_DEFERRED_CONFLICT_RE.test(line)).length === rows.length
    && rows.length > 0 && rows.every((value) => value === HARVEST_DEFERRED_MARKER_VALUE);
}

export function decideDraft({ draft, runStatus, mergedTwins, openDrafts, ageHours, liveBranches, finalRunResult }: DraftTriageInput): DraftDecision {
  // DRAFT-ZERO — a verified harvest-deferred marker is the strongest hold: it outranks protected labels
  // and every close rule, so a failed run's harvestable draft survives the sweep for harvest.
  if (runStatus === 'failed' && harvestDeferredMarker(draft.body)) return { action: 'keep', reason: 'harvest-deferred' };
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
  const draftSlot = slot(draft.body);
  const stem = branchStem(draft.branch);
  const compatible = (pr: DraftTriagePr): boolean =>
    !(lineage && goalId(pr.branch) && goalId(pr.branch) !== lineage)
    && !(draftSlot && slot(pr.body) && slot(pr.body) !== draftSlot);
  const twin = mergedTwins.find((pr) => pr.number !== draft.number && compatible(pr) && sameGoalPr(draft, pr));
  if (twin) return { action: 'close', reason: `superseded-by #${twin.number}` };
  const createdAt = Date.parse(draft.createdAt ?? '');
  const newer = stem && draft.title && Number.isFinite(createdAt) ? openDrafts
    ?.filter((pr) => pr.number !== draft.number && pr.title === draft.title && branchStem(pr.branch) === stem && sameGoalPr(draft, pr)
      && Number.isFinite(Date.parse(pr.createdAt ?? '')) && Date.parse(pr.createdAt!) > createdAt)
    .sort((a, b) => Date.parse(b.createdAt!) - Date.parse(a.createdAt!) || b.number - a.number)[0] : undefined;
  if (newer) return { action: 'close', reason: `duplicate-of-open #${newer.number}` };
  const harvest = mergedTwins.find((pr) => pr.number !== draft.number && compatible(pr) && (
    [pr.mergeCommitMessage, pr.body].some((text) => text && referencesDraft(text, draft.number))
    || pr.landingVerifiedComments?.some((text) => landingCommentReferencesDraft(text, draft.number))
  ));
  if (harvest) return { action: 'close', reason: `superseded-by #${harvest.number} (harvest #${draft.number})` };
  const created = Date.parse(draft.createdAt ?? '');
  const files = draft.changedFiles;
  const later = laterMergedTwins(draft, mergedTwins);
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
