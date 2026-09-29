import { CLAIM_IDLE_HOURS, PR_LABELS } from '../github/pr-labels.js';
import { decideDraft, type DraftTriagePr } from './draft-triage-rules.js';

export interface SweepDraft extends DraftTriagePr {
  readonly title: string;
  readonly labels: readonly string[];
  readonly createdAt: string;
  /** Last PR update (push, label, comment). Missing ⇒ running claim stays untouched; other drafts use legacy triage. */
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
  /** Undefined means no run assessment; it does not authorize a close. */
  getRunStatus(draft: SweepDraft, repository: string): Promise<string | undefined>;
  /** Undefined means liveness could not be established. */
  listLiveBranches(repository: string): Promise<ReadonlySet<string> | undefined>;
  setLabels(repository: string, number: number, change: { add: string; remove: readonly string[] }): Promise<void>;
  closeDraft(repository: string, number: number, comment: string): Promise<void>;
  /** Resolve the latest claim comment owner; a failed lookup must not authorize a close. */
  getClaimOwner?(repository: string, number: number): Promise<string | undefined>;
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
  /** Drafts whose run could not be observed from here (kept, or closed by the idle rule). */
  unobserved?: number;
  /** Closes decided this tick (at most DRAFT_SWEEP_CLOSE_CAP). */
  closed?: number;
  /** Fresh running claims protected this tick. */
  claimed?: number;
  /** Running claims older than the idle window, including those kept by liveness. */
  claimExpired?: number;
  error?: string;
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
const PAGE_SIZE = 100;
/** 🅢 2026-09-28 (lead decision, channel #20798 04:1x): a run the sweeper cannot see is closed as stalled only when its branch
 *  is not in a host worktree and the draft has been idle this long. A Pod lives at most POD_JOB_DEADLINE_SECONDS (3h), so a
 *  draft idle for 48h cannot belong to a running Pod — the «not in a running Pod» condition follows from the idle time. */
export const UNOBSERVED_IDLE_CLOSE_HOURS = 48;
/** At most this many closes per tick, so a wrong rule cannot close everything at once. */
export const DRAFT_SWEEP_CLOSE_CAP = 10;

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

/** A failed inventory or liveness lookup is never treated as proof that a draft can be closed. */
export async function runDraftSweep({ repository, adapters, apply = false, now = new Date() }: DraftSweepOptions): Promise<DraftSweepResult> {
  const result: DraftSweepResult = { repository, apply, complete: false, entries: [] };
  let drafts: SweepDraft[];
  let merged: SweepMergedPr[];
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
    result.error = String(error);
    return result;
  }
  let statuses: Map<number, string | undefined>;
  try {
    statuses = new Map<number, string | undefined>();
    for (const draft of drafts) statuses.set(draft.number, await adapters.getRunStatus(draft, repository));
  } catch (error) {
    result.error = String(error);
    return result;
  }
  result.complete = true;
  let closes = 0;
  let unobserved = 0;
  let claimed = 0;
  let claimExpired = 0;
  for (const draft of drafts) {
    const runStatus = statuses.get(draft.number);
    const states = stateLabels.filter((state) => draft.labels.includes(state.name));
    const contradiction = states.length > 1 || draft.labels.includes(approvalLabel ?? '');
    if (!contradiction && draft.labels.includes(keepLabel ?? '')) {
      result.entries.push({ number: draft.number, action: 'keep', reason: `label:${keepLabel}`, applied: false });
      continue;
    }
    const isClaimed = !contradiction && draft.labels.includes(runningLabel);
    const ageHours = (now.getTime() - Date.parse(draft.createdAt)) / 3_600_000;
    // An unobserved claim may still have a merged twin: liveness/holds retain their priority,
    // but a superseded draft must not be hidden by the six-hour claim window.
    const mergedDecision = isClaimed ? decideDraft({ draft, runStatus: runStatus ?? 'ended-unclosed', mergedTwins: merged, liveBranches, ageHours }) : undefined;
    const supersededClaim = mergedDecision?.reason.startsWith('superseded-by #') === true;
    // Without an observed update time, neither expiration nor a fallback to creation time can authorize mutation —
    // but a merged twin does not need the update time, so superseded keeps its priority over the unobserved claim.
    if (isClaimed && !supersededClaim && (typeof draft.updatedAt !== 'string' || !Number.isFinite(Date.parse(draft.updatedAt)))) {
      result.entries.push({ number: draft.number, action: 'keep', reason: 'claim-update-unobserved', applied: false });
      continue;
    }
    const claimIdleHours = draft.updatedAt === undefined ? NaN : (now.getTime() - Date.parse(draft.updatedAt)) / 3_600_000;
    if (isClaimed && !supersededClaim && Number.isFinite(claimIdleHours) && claimIdleHours < CLAIM_IDLE_HOURS) {
      claimed += 1;
      result.entries.push({ number: draft.number, action: 'keep', reason: `label:running(<${CLAIM_IDLE_HOURS}h)`, applied: false });
      continue;
    }
    if (isClaimed && !supersededClaim && Number.isFinite(claimIdleHours) && claimIdleHours >= CLAIM_IDLE_HOURS) {
      claimExpired += 1;
      if (runStatus === 'running' || runStatus === 'probable-running' || liveBranches.has(draft.branch)) {
        result.entries.push({ number: draft.number, action: 'keep', reason: 'claim-expired-but-live', applied: false });
        continue;
      }
      const action = closes >= DRAFT_SWEEP_CLOSE_CAP ? 'keep' : 'close';
      if (action === 'close') closes += 1;
      const entry: DraftSweepEntry = { number: draft.number, action, reason: action === 'close' ? 'claim-expired' : 'close-cap',
        ...(action === 'close' ? { statusLabel: stalledLabel } : {}), applied: false };
      result.entries.push(entry);
      if (!apply || action !== 'close') continue;
      let labelsChanged = false;
      try {
        const owner = await adapters.getClaimOwner?.(repository, draft.number) ?? '미상';
        await adapters.setLabels(repository, draft.number, { add: stalledLabel, remove: [runningLabel] });
        labelsChanged = true;
        await adapters.closeDraft(repository, draft.number,
          `Draft sweep: 처리 중 표식이 ${CLAIM_IDLE_HOURS}시간 갱신 없음 — 런·워크트리 없음 · 주인 ${owner}. Closed as stalled. Branch preserved; reopen to restore.`);
        entry.applied = true;
      } catch (error) {
        if (labelsChanged) entry.partialApplied = true;
        entry.error = String(error);
      }
      continue;
    }
    // Unlabelled non-harness drafts are outside the sweeper's jurisdiction.
    if (!contradiction && !states.length && !draft.branch.startsWith('self-impl/')) {
      result.entries.push({ number: draft.number, action: 'keep', reason: 'outside-harness', applied: false });
      continue;
    }
    let decision = supersededClaim ? mergedDecision! : decideDraft({ draft, runStatus, mergedTwins: merged, liveBranches, ageHours });
    if (decision.reason === 'unobserved') {
      unobserved += 1;
      const idleHours = (now.getTime() - Date.parse(draft.updatedAt ?? draft.createdAt)) / 3_600_000;
      if (!liveBranches.has(draft.branch) && Number.isFinite(idleHours) && idleHours >= UNOBSERVED_IDLE_CLOSE_HOURS) {
        decision = { action: 'close', reason: 'unobserved-idle' };
      }
    }
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
      ? decision.reason.startsWith('superseded-by #') ? supersededLabel : stalledLabel
      : isLive ? (states.length ? runningLabel : undefined) : runStatus && (states[0]?.name === runningLabel || states.length === 0) ? stalledLabel : undefined;
    const entry: DraftSweepEntry = { number: draft.number, action, reason, ...(target ? { statusLabel: target } : {}), applied: false };
    result.entries.push(entry);
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
        await adapters.closeDraft(repository, draft.number, decision.reason === 'unobserved-idle'
          ? `Draft sweep: run unobserved — no run record reachable here, no host worktree for this branch, idle ≥${UNOBSERVED_IDLE_CLOSE_HOURS}h. Closed as stalled. Branch preserved; reopen to restore.`
          : `Draft sweep: ${decision.reason}. Branch preserved.`);
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
  return result;
}
