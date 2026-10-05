import { CLAIM_IDLE_HOURS, PR_LABELS, STALLED_DRAFT_HOURS } from '../github/pr-labels.js';
import { debug } from '../debug/log.js';
import { decideDraft, sameGoalPr, type DraftTriagePr } from './draft-triage-rules.js';

export interface SweepDraft extends DraftTriagePr {
  readonly title: string;
  readonly labels: readonly string[];
  readonly createdAt: string;
  /** Last PR update (push, label, comment). Missing ⇒ no idle-based close; merged twins can still close. */
  readonly updatedAt?: string;
  readonly runId?: string | null;
}

export interface SweepMergedPr extends DraftTriagePr {
  readonly title: string;
}

export interface DraftSweepAdapters {
  /** Each call returns one complete page; a rejection must not be mistaken for an empty page. */
  listDrafts(page: number, perPage: number, repository: string): Promise<readonly SweepDraft[]>;
  listMerged(page: number, perPage: number, repository: string): Promise<readonly SweepMergedPr[]>;
  /** Undefined means no run assessment; a merged twin or 24h idle draft can still authorize a close. */
  getRunStatus(draft: SweepDraft, repository: string): Promise<string | undefined>;
  /** Undefined means liveness could not be established. */
  listLiveBranches(repository: string): Promise<ReadonlySet<string> | undefined>;
  setLabels(repository: string, number: number, change: { add: string; remove: readonly string[] }): Promise<void>;
  closeDraft(repository: string, number: number, comment: string): Promise<void>;
  /** Resolve the latest claim comment owner; a failed lookup must not authorize a close. */
  getClaimOwner?(repository: string, number: number): Promise<string | undefined>;
  /** Whether the current owned run has a self-implement.result final observation, even if its worktree remains. */
  hasFinalRunResult?(draft: SweepDraft, repository: string): Promise<boolean | undefined>;
  /** Per-file last change on the draft branch; undefined means file coverage is unverified. */
  getLatestFileChanges?(draft: SweepDraft, repository: string): Promise<Readonly<Record<string, string>> | undefined>;
  /** Optional merge-time file inventory for the existing all-files-landed decision. */
  getPrFiles?(repository: string, number: number): Promise<readonly string[] | undefined>;
  /**
   * Review and gate posture for the daily count. Omitted means unknown — not harvestable and not blocked.
   * `review: 'pass'` is a review PASS; `mustFix` means must-fix remains; `gate: 'pass'` is a green gate.
   */
  getReviewGate?(draft: SweepDraft, repository: string): Promise<SweepReviewGate | undefined>;
}

/** Review PASS and gate posture used only by the daily old-draft count. */
export interface SweepReviewGate {
  readonly review?: 'pass' | 'fail';
  readonly mustFix?: boolean;
  readonly gate?: 'pass' | 'fail';
}

export interface DraftSweepOptions {
  repository: string;
  adapters: DraftSweepAdapters;
  apply?: boolean;
  now?: Date;
}

export interface DraftSweepEntry {
  number: number;
  action: 'keep' | 'close' | 'report';
  reason: string;
  statusLabel?: string;
  applied: boolean;
  /** Labels changed successfully, but the requested close failed. */
  partialApplied?: boolean;
  error?: string;
}

export interface DraftSweepResult {
  repository: string;
  apply: boolean;
  complete: boolean;
  entries: DraftSweepEntry[];
  counts: Record<string, number>;
  /** Drafts whose run could not be observed from here (kept, or closed by the idle rule). */
  unobserved?: number;
  /** Closes decided this tick (at most DRAFT_SWEEP_CLOSE_CAP). */
  closed?: number;
  /** Fresh running claims protected this tick. */
  claimed?: number;
  /** Running claims older than the idle window, including those kept by liveness. */
  claimExpired?: number;
  /**
   * One line per sweep: harness drafts older than 24h, split into closable (a same-goal landing exists),
   * harvestable (review PASS and gate pass), and blocked (must-fix remains).
   */
  daily?: DraftSweepDaily;
  error?: string;
}

/** Daily old-draft census. `date` is the sweep clock's UTC calendar day. */
export interface DraftSweepDaily {
  readonly date: string;
  readonly over24h: number;
  readonly closable: number;
  readonly harvestable: number;
  readonly blocked: number;
}

const stateLabels = PR_LABELS.filter((label) => label.axis === 'state');
const label = (action: 'mark-stalled' | 'close', name?: string): string => {
  const match = PR_LABELS.find((entry) => entry.axis === 'state' && entry.sweep.action === action && (name === undefined || entry.name.endsWith(name)));
  if (!match) throw new Error(`Missing registered PR state for ${action}`);
  return match.name;
};
const runningLabel = label('mark-stalled');
const stalledLabel = label('close', 'stalled');
const supersededLabel = label('close', 'superseded');
const approvalLabel = PR_LABELS.find((entry) => entry.axis === 'state' && entry.sweep.action === 'none')?.name;
const keepLabel = PR_LABELS.find((entry) => entry.sweep.action === 'exclude')?.name;
const releaseHoldLabel = PR_LABELS.find((entry) => entry.axis === 'addon' && entry.sweep.action === 'none')?.name;
const PAGE_SIZE = 100;
/** At most this many closes per tick, so a wrong rule cannot close everything at once. */
export const DRAFT_SWEEP_CLOSE_CAP = 10;

/** Post-merge shortcut: only the existing superseded-by decision can authorize a close. */
export async function supersedeDraftsOnMerge(input: {
  repository: string;
  merged: SweepMergedPr & { createdAt: string; mergedAt: string };
  adapters: Pick<DraftSweepAdapters, 'listDrafts' | 'listLiveBranches' | 'getRunStatus' | 'setLabels' | 'closeDraft'>
    & Pick<Partial<DraftSweepAdapters>, 'getLatestFileChanges' | 'getPrFiles'>;
}): Promise<{ closed: number[]; kept: number[] }> {
  const { repository, merged, adapters } = input;
  const closed: number[] = [];
  const kept: number[] = [];
  let drafts: SweepDraft[] = [];
  let error: string | undefined;
  const failed: number[] = [];
  let closeAttempts = 0;
  try {
    const [listedDrafts, liveBranches] = await Promise.all([
      collectPages((page, size) => adapters.listDrafts(page, size, repository)),
      adapters.listLiveBranches(repository),
    ]);
    drafts = listedDrafts;
    if (!liveBranches || !Number.isInteger(merged.number) || !merged.branch || !merged.title
      || !Number.isFinite(Date.parse(merged.createdAt)) || !Number.isFinite(Date.parse(merged.mergedAt))
      || drafts.some((pr) => !Number.isInteger(pr.number) || !pr.branch || !Array.isArray(pr.labels)
        || !Number.isFinite(Date.parse(pr.createdAt)))) throw new Error('Incomplete merge draft inventory');
    const statuses = new Map<number, string | undefined>();
    const latestChanges = new Map<number, Readonly<Record<string, string>> | undefined>();
    const mergedFiles = await adapters.getPrFiles?.(repository, merged.number);
    const landed = { ...merged, changedFiles: mergedFiles };
    for (const draft of drafts) {
      if (draft.number !== merged.number && draft.branch.startsWith('self-impl/') && !liveBranches.has(draft.branch)
        && Date.parse(draft.createdAt) < Date.parse(merged.mergedAt)) {
        statuses.set(draft.number, await adapters.getRunStatus(draft, repository));
        if (draft.changedFiles?.length && adapters.getLatestFileChanges) {
          latestChanges.set(draft.number, await adapters.getLatestFileChanges(draft, repository));
        }
      }
    }
    for (const listedDraft of drafts) {
      const draft = { ...listedDraft, latestFileChanges: latestChanges.get(listedDraft.number) };
      if (draft.number === merged.number || !draft.branch.startsWith('self-impl/') || liveBranches.has(draft.branch)
        || Date.parse(draft.createdAt) >= Date.parse(merged.mergedAt)) {
        kept.push(draft.number);
        continue;
      }
      const decision = decideDraft({ draft, runStatus: statuses.get(draft.number),
        mergedTwins: [landed], liveBranches, ageHours: NaN });
      if (decision.action !== 'close' || !decision.reason.startsWith(`superseded-by #${merged.number}`)
        || PR_LABELS.filter((entry) => entry.axis === 'state' && draft.labels.includes(entry.name)).length > 1
        || closeAttempts >= DRAFT_SWEEP_CLOSE_CAP) {
        kept.push(draft.number);
        continue;
      }
      closeAttempts += 1;
      const remove = stateLabels.filter((entry) => draft.labels.includes(entry.name) && entry.name !== supersededLabel).map((entry) => entry.name);
      try {
        // Label first: a failed label write must never strand a closed, unlabelled PR outside open-draft sweeps.
        if (!draft.labels.includes(supersededLabel)) await adapters.setLabels(repository, draft.number, { add: supersededLabel, remove });
        await adapters.closeDraft(repository, draft.number,
          `Draft sweep: superseded-by #${merged.number} (https://github.com/${repository}/pull/${merged.number}). Branch preserved.`);
        closed.push(draft.number);
      } catch (failure) {
        kept.push(draft.number);
        failed.push(draft.number);
        error = String(failure);
      }
    }
  } catch (failure) {
    error = String(failure);
    kept.push(...drafts.map((draft) => draft.number).filter((number) => !closed.includes(number) && !kept.includes(number)));
  }
  debug.log('drafts.cleanup', 'superseded-on-merge', { merged: merged.number, closed, kept, ...(failed.length ? { failed } : {}), ...(error ? { error } : {}) });
  return { closed, kept };
}

async function collectPages<T>(fetch: (page: number, perPage: number) => Promise<readonly T[]>): Promise<T[]> {
  const rows: T[] = [];
  for (let page = 1; page <= 100; page++) {
    const next = await fetch(page, PAGE_SIZE);
    if (!Array.isArray(next) || next.length > PAGE_SIZE) throw new Error('Incomplete PR page');
    rows.push(...next);
    if (next.length < PAGE_SIZE) return rows;
  }
  throw new Error('PR listing exceeded pagination limit');
}

/** First line of a failure, with no stack — the draft-cleanup loop log shows this line as-is. */
export function sweepFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const line = message.split(/\r?\n/).map((part) => part.trim()).find((part) => part.length > 0 && !/^\s*at\s/.test(part));
  return line && line.length > 0 ? line : 'sweep failed';
}

function harnessDraft(draft: SweepDraft): boolean {
  return draft.branch.startsWith('self-impl/') || draft.labels.some((name) => name.startsWith('elanous:'));
}

/**
 * Census of harness drafts older than 24h. Same-goal landing uses `sameGoalPr` unchanged.
 * A draft counts as closable when a same-goal merged PR exists, harvestable when review PASS and the gate passed,
 * and blocked when must-fix remains. Unknown review/gate is neither harvestable nor blocked.
 */
export function draftSweepDaily(
  drafts: readonly SweepDraft[],
  merged: readonly SweepMergedPr[],
  now: Date,
  reviewGate: ReadonlyMap<number, SweepReviewGate | undefined>,
): DraftSweepDaily {
  const cutoff = now.getTime() - STALLED_DRAFT_HOURS * 3_600_000;
  let over24h = 0;
  let closable = 0;
  let harvestable = 0;
  let blocked = 0;
  for (const draft of drafts) {
    if (!harnessDraft(draft)) continue;
    const created = Date.parse(draft.createdAt);
    if (!Number.isFinite(created) || created > cutoff) continue;
    over24h += 1;
    if (merged.some((pr) => pr.number !== draft.number && sameGoalPr(draft, pr))) closable += 1;
    const posture = reviewGate.get(draft.number);
    if (posture?.mustFix === true) blocked += 1;
    else if (posture?.review === 'pass' && posture.gate === 'pass') harvestable += 1;
  }
  return { date: now.toISOString().slice(0, 10), over24h, closable, harvestable, blocked };
}

/** A failed inventory or liveness lookup is never treated as proof that a draft can be closed. */
export async function runDraftSweep({ repository, adapters, apply = false, now = new Date() }: DraftSweepOptions): Promise<DraftSweepResult> {
  const result: DraftSweepResult = { repository, apply, complete: false, entries: [], counts: {} };
  const record = (entry: DraftSweepEntry): void => {
    result.entries.push(entry);
    result.counts[entry.reason] = (result.counts[entry.reason] ?? 0) + 1;
    debug.log('drafts.cleanup', 'decided', { number: entry.number, action: entry.action, reason: entry.reason });
  };
  const finish = (): DraftSweepResult => {
    debug.log('drafts.cleanup', 'summary', result.counts);
    if (result.daily) debug.log('harness.drafts', 'daily', result.daily);
    if (!result.complete && result.error) debug.log('drafts.cleanup', 'failed', { reason: sweepFailureReason(result.error) });
    return result;
  };
  let drafts: SweepDraft[] = [];
  let merged: SweepMergedPr[] = [];
  let liveBranches: ReadonlySet<string> | undefined;
  try {
    [drafts, merged, liveBranches] = await Promise.all([
      collectPages((page, size) => adapters.listDrafts(page, size, repository)),
      collectPages((page, size) => adapters.listMerged(page, size, repository)),
      adapters.listLiveBranches(repository),
    ]);
    if (!liveBranches) throw new Error('Branch liveness unavailable');
    if (drafts.some((pr) => !Number.isInteger(pr.number) || !pr.branch || !Array.isArray(pr.labels) || !Number.isFinite(Date.parse(pr.createdAt)))
      || merged.some((pr) => !Number.isInteger(pr.number) || !pr.branch)) throw new Error('Invalid PR inventory');
  } catch (error) {
    result.error = sweepFailureReason(error);
    if (drafts.length > 0) result.daily = draftSweepDaily(drafts, merged, now, new Map());
    return finish();
  }
  let statuses: Map<number, string | undefined>;
  let finality: Map<number, boolean | undefined>;
  let latestFileChanges: Map<number, Readonly<Record<string, string>> | undefined>;
  try {
    statuses = new Map<number, string | undefined>();
    finality = new Map<number, boolean | undefined>();
    latestFileChanges = new Map<number, Readonly<Record<string, string>> | undefined>();
    for (const draft of drafts) {
      const status = await adapters.getRunStatus(draft, repository);
      // A prior final cannot terminate a new active run on the same draft.
      const active = status === 'running' || status === 'probable-running';
      const final = active ? false : await adapters.hasFinalRunResult?.(draft, repository);
      finality.set(draft.number, final);
      statuses.set(draft.number, final ? 'self-implement.result final' : status);
      if (draft.changedFiles?.length && adapters.getLatestFileChanges) {
        latestFileChanges.set(draft.number, await adapters.getLatestFileChanges(draft, repository));
      }
    }
  } catch (error) {
    result.error = sweepFailureReason(error);
    return finish();
  }
  let reviewGate = new Map<number, SweepReviewGate | undefined>();
  if (adapters.getReviewGate) {
    try {
      for (const draft of drafts) reviewGate.set(draft.number, await adapters.getReviewGate(draft, repository));
    } catch (error) {
      result.error = sweepFailureReason(error);
      return finish();
    }
  }
  result.daily = draftSweepDaily(drafts, merged, now, reviewGate);
  result.complete = true;
  let closes = 0;
  let unobserved = 0;
  let claimed = 0;
  let claimExpired = 0;
  for (const listedDraft of drafts) {
    const draft = { ...listedDraft, latestFileChanges: latestFileChanges.get(listedDraft.number) };
    const runStatus = statuses.get(draft.number);
    const finalRunResult = finality.get(draft.number);
    const states = stateLabels.filter((state) => draft.labels.includes(state.name));
    const contradiction = states.length > 1 || draft.labels.includes(approvalLabel ?? '');
    if (draft.labels.includes(releaseHoldLabel ?? '') || (!contradiction && draft.labels.includes(keepLabel ?? ''))) {
      const held = draft.labels.includes(keepLabel ?? '') ? keepLabel : releaseHoldLabel;
      record({ number: draft.number, action: 'keep', reason: `label:${held}`, applied: false });
      continue;
    }
    const isClaimed = !contradiction && draft.labels.includes(runningLabel);
    const ageHours = (now.getTime() - Date.parse(draft.createdAt)) / 3_600_000;
    const idleHours = typeof draft.updatedAt === 'string' && Number.isFinite(Date.parse(draft.updatedAt))
      ? (now.getTime() - Date.parse(draft.updatedAt)) / 3_600_000 : NaN;
    // An unobserved claim may still have a merged twin: liveness/holds retain their priority,
    // but a superseded draft must not be hidden by the six-hour claim window.
    const mergedDecision = isClaimed ? decideDraft({ draft, runStatus, mergedTwins: merged, openDrafts: drafts, liveBranches,
      finalRunResult, ageHours: idleHours }) : undefined;
    const supersededClaim = mergedDecision?.reason.startsWith('superseded-by #') === true
      || mergedDecision?.reason.startsWith('duplicate-of-open #') === true;
    if (!contradiction && mergedDecision?.reason === 'branch-finality-unobserved') {
      record({ number: draft.number, action: 'keep', reason: mergedDecision.reason, applied: false });
      continue;
    }
    // Without an observed update time, neither expiration nor a fallback to creation time can authorize mutation —
    // but a merged twin does not need the update time, so superseded keeps its priority over the unobserved claim.
    if (isClaimed && !supersededClaim && (typeof draft.updatedAt !== 'string' || !Number.isFinite(Date.parse(draft.updatedAt)))) {
      record({ number: draft.number, action: 'keep', reason: 'claim-update-unobserved', applied: false });
      continue;
    }
    if (isClaimed && !supersededClaim && Number.isFinite(idleHours) && idleHours < CLAIM_IDLE_HOURS) {
      claimed += 1;
      record({ number: draft.number, action: 'keep', reason: `label:running(<${CLAIM_IDLE_HOURS}h)`, applied: false });
      continue;
    }
    if (isClaimed && !supersededClaim && Number.isFinite(idleHours) && idleHours >= CLAIM_IDLE_HOURS) {
      claimExpired += 1;
      if (liveBranches.has(draft.branch) && finalRunResult === undefined
        && runStatus !== 'running' && runStatus !== 'probable-running') {
        record({ number: draft.number, action: 'keep', reason: 'branch-finality-unobserved', applied: false });
        continue;
      }
      if (runStatus === 'running' || runStatus === 'probable-running' ||
        (runStatus !== 'self-implement.result final' && liveBranches.has(draft.branch))) {
        record({ number: draft.number, action: 'keep', reason: 'claim-expired-but-live', applied: false });
        continue;
      }
      const action = closes >= DRAFT_SWEEP_CLOSE_CAP ? 'keep' : 'close';
      if (action === 'close') closes += 1;
      const entry: DraftSweepEntry = { number: draft.number, action,
        reason: action === 'close' ? runStatus === 'self-implement.result final'
          ? 'claim-expired (self-implement.result final; worktree is not live)' : 'claim-expired' : 'close-cap',
        ...(action === 'close' ? { statusLabel: stalledLabel } : {}), applied: false };
      record(entry);
      if (!apply || action !== 'close') continue;
      let labelsChanged = false;
      try {
        const owner = await adapters.getClaimOwner?.(repository, draft.number) ?? '미상';
        await adapters.setLabels(repository, draft.number, { add: stalledLabel, remove: [runningLabel] });
        labelsChanged = true;
        await adapters.closeDraft(repository, draft.number,
          `Draft sweep: 처리 중 표식이 ${CLAIM_IDLE_HOURS}시간 갱신 없음 — ${runStatus === 'self-implement.result final' ? 'self-implement.result final · 남은 워크트리는 live 아님' : '런·워크트리 없음'} · 주인 ${owner}. Closed as stalled. Branch preserved; reopen to restore.`);
        entry.applied = true;
      } catch (error) {
        if (labelsChanged) entry.partialApplied = true;
        entry.error = String(error);
      }
      continue;
    }
    // Unlabelled non-harness drafts are outside the sweeper's jurisdiction.
    if (!contradiction && !states.length && !draft.branch.startsWith('self-impl/')) {
      record({ number: draft.number, action: 'keep', reason: 'outside-harness', applied: false });
      continue;
    }
    let decision = supersededClaim ? mergedDecision! : decideDraft({ draft, runStatus, mergedTwins: merged, openDrafts: drafts, liveBranches,
      finalRunResult, ageHours: runStatus ? ageHours : idleHours });
    if (!runStatus && (decision.reason === 'unobserved' || decision.reason === 'stale-unobserved')) unobserved += 1;
    if (!contradiction && decision.action === 'close') {
      if (closes >= DRAFT_SWEEP_CLOSE_CAP) decision = { action: 'keep', reason: 'close-cap' };
      else closes += 1;
    }
    const action = contradiction ? 'report' : decision.action;
    const reason = contradiction
      ? (states.length > 1 ? 'conflicting-state-labels' : 'approval-label-on-draft')
      : decision.reason;
    const isLive = decision.reason === 'live';
    const target = action === 'report' ? undefined : action === 'close'
      ? decision.reason.startsWith('superseded-by #') || decision.reason.startsWith('duplicate-of-open #') ? supersededLabel : stalledLabel
      : isLive ? (states.length ? runningLabel : undefined) : runStatus && (states[0]?.name === runningLabel || states.length === 0) ? stalledLabel : undefined;
    const entry: DraftSweepEntry = { number: draft.number, action, reason, ...(target ? { statusLabel: target } : {}), applied: false };
    record(entry);
    if (!apply || action === 'report') continue;
    let labelsChanged = false;
    try {
      if (target && !draft.labels.includes(target)) {
        await adapters.setLabels(repository, draft.number, {
          add: target, remove: states.map((state) => state.name).filter((name) => name !== target),
        });
        labelsChanged = true;
      }
      if (action === 'close') {
        await adapters.closeDraft(repository, draft.number, decision.reason === 'stale-unobserved'
          ? `Draft sweep: run unobserved — no run record reachable here, no host worktree for this branch, idle ≥${STALLED_DRAFT_HOURS}h. Closed as stalled. Branch preserved; reopen to restore.`
          : `Draft sweep: ${decision.reason}${decision.reason.startsWith('superseded-by #')
            ? ` (https://github.com/${repository}/pull/${decision.reason.slice('superseded-by #'.length).match(/^\d+/)![0]})` : ''}. Branch preserved.`);
      }
      entry.applied = labelsChanged || action === 'close';
    } catch (error) {
      if (labelsChanged && action === 'close') entry.partialApplied = true;
      entry.error = String(error);
    }
  }
  result.unobserved = unobserved;
  result.closed = closes;
  result.claimed = claimed;
  result.claimExpired = claimExpired;
  return finish();
}
