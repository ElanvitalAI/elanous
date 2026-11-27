// LLM-ROUTE-BY-GUARDIAN · review start (CEO 11-27 10:2x «리뷰 시작 시나리오») — what `eln review` does with a review
// before and after the reviewer runs. Pure.
//   • a PR with main merged into it → the reviewed diff is merge-base(base, head)..head (`eln self review` does this
//     itself since REVIEW-ACCEPT-MERGE-MAIN; no refusal here);
//   • a delta re-review whose diff is over the reviewer budget → not a refusal: a full re-review of the PR's own change
//     (a true range-diff path in `self review` is a follow-up; until then the full review is the honest fallback);
//   • the PR head moved while the reviewer ran → the result is not a verdict for the new head: re-queue, never record.

export type ReviewDiffPath = 'full' | 'merge-base' | 'delta' | 'full-rereview';
export interface ReviewStartFacts {
  /** The head carries merge commits from main (the old A204 «needs-clean-branch»). */
  readonly mainMerged: boolean;
  /** A saved review of an older head exists (delta re-review possible). */
  readonly savedReviewHead: string | null;
  /** Size of head − saved head, chars; null = unknown. */
  readonly deltaChars: number | null;
  readonly deltaBudgetChars: number;
}
export interface ReviewStartPlan { readonly path: ReviewDiffPath; readonly why: string; readonly extraArgs: readonly string[] }

export function planReviewStart(f: ReviewStartFacts): ReviewStartPlan {
  if (f.mainMerged && !f.savedReviewHead) return { path: 'merge-base', why: 'main merged into the PR — review merge-base..head (the PR\'s own change)', extraArgs: [] };
  if (f.savedReviewHead && f.deltaChars !== null && f.deltaChars > f.deltaBudgetChars)
    return { path: 'full-rereview', why: `delta ${f.deltaChars} chars > budget ${f.deltaBudgetChars} — full re-review instead of a refusal`, extraArgs: ['--full'] };
  if (f.savedReviewHead) return { path: 'delta', why: `delta since ${f.savedReviewHead.slice(0, 12)}`, extraArgs: [] };
  return { path: f.mainMerged ? 'merge-base' : 'full', why: f.mainMerged ? 'main merged — merge-base review' : 'first review', extraArgs: [] };
}

export type ReviewEndAction = 'record' | 'requeue' | 'retry-full' | 'retry-other-route' | 'stop';
export interface ReviewEndFacts {
  readonly headAtStart: string;
  readonly headNow: string | null;
  /** The reviewer's structured result (null = none parsed). */
  readonly result: { readonly reviewed?: boolean; readonly verdict?: string | null; readonly refusal?: string | null; readonly headCommit?: string | null; readonly deltaRefusal?: string | null } | null;
  /** Raw output text (stderr+stdout) for failure classification when there is no result. */
  readonly text: string;
}

/** After the reviewer: record the verdict only when it is for the head the review started on and that head is still
 *  the PR head; a moved head → re-queue (no false verdict); a provider failure → another route; a refusal → stop. */
export function judgeReviewEnd(f: ReviewEndFacts): { action: ReviewEndAction; why: string } {
  const r = f.result;
  // The PR head could not be read after the review: the verdict cannot be bound to the current head — re-queue, never record.
  if (!f.headNow) return { action: 'requeue', why: `head unverifiable after review (gh pr view failed) — re-queued, no verdict recorded` };
  if (f.headNow !== f.headAtStart) return { action: 'requeue', why: `head moved ${f.headAtStart.slice(0, 12)} → ${f.headNow.slice(0, 12)} during review — re-queued, no verdict recorded` };
  if (r?.reviewed === true) {
    if (r.headCommit && r.headCommit !== f.headAtStart) return { action: 'requeue', why: `result is for ${r.headCommit.slice(0, 12)}, not ${f.headAtStart.slice(0, 12)} — re-queued` };
    return { action: 'record', why: `verdict ${r.verdict ?? '?'} for ${f.headAtStart.slice(0, 12)}` };
  }
  if (r?.refusal && /head.*(?:changed|mismatch)|identity/u.test(`${r.refusal} ${r.deltaRefusal ?? ''}`)) return { action: 'requeue', why: `identity refusal ${r.refusal} — re-queued` };
  if (r?.refusal && /delta-diff-over/u.test(r.deltaRefusal ?? '')) return { action: 'retry-full', why: `delta over budget (${r.deltaRefusal}) — full re-review` };
  if (r?.refusal) return { action: 'stop', why: `reviewer refused before the model: ${r.refusal}${r.deltaRefusal ? ` (${r.deltaRefusal})` : ''}` };
  return { action: 'retry-other-route', why: f.text.trim().split('\n').slice(-1)[0]?.slice(0, 200) || 'no result' };
}
