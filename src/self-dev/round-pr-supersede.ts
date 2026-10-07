// DRAFT-TRIAGE (TC 10-07) — a supervisor rework round of the same run and goal opens a new PR
// (new task id → new goal hash → new branch). Continuing the branch would mean pinning the shard
// identity and the Pod child's run suffix, so this closes the previous round's draft instead:
// label `elanous:superseded`, comment with the newer PR link, close. Same run = one tracker per
// supervised invocation; same goal = `resumeKey(feature)`, the key the resume path already uses.

import { spawnSync } from 'node:child_process';
import { debug } from '../debug/log.js';
import { PR_LABELS } from '../github/pr-labels.js';
import { PROTECTED_LABELS } from './draft-triage-rules.js';
import { resumeKey, type SelfDevJobResult } from './orchestrate.js';

const SUPERSEDED_LABEL = PR_LABELS.find((label) => label.name.endsWith(':superseded'))!.name;

export interface RoundPrRef {
  readonly repository: string;
  readonly number: number;
  readonly url: string;
}

export interface RoundPrView {
  readonly state: string;
  readonly isDraft: boolean;
  readonly labels: readonly string[];
  readonly mergedAt?: string | null;
  /** Comment bodies — a link already posted (even by a write that reported failure) is not posted again.
   *  An adapter that cannot read them returns a null view, so nothing is written. */
  readonly comments: readonly string[];
}

/** gh seams. A null view or a false write means «not observed / not applied» — never a reason to close. */
export interface RoundPrAdapters {
  view(pr: RoundPrRef): RoundPrView | null;
  addLabel(pr: RoundPrRef, label: string): boolean;
  comment(pr: RoundPrRef, body: string): boolean;
  close(pr: RoundPrRef): boolean;
}

type SupersedeOutcome =
  | { kind: 'superseded'; round: number; prevPr: number; pr: number }
  | { kind: 'kept'; round: number; prevPr: number; pr: number; reason: string };

type RoundPrOutcome = SupersedeOutcome | { kind: 'continued'; round: number; prevPr: number; pr: number };

export function roundPrRef(prUrl: string | undefined): RoundPrRef | null {
  if (!prUrl) return null;
  try {
    const url = new URL(prUrl.trim());
    const match = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/.exec(url.pathname);
    return url.protocol === 'https:' && url.hostname === 'github.com' && match
      // GitHub owner/repo names are case-insensitive: one PR has one identity.
      ? { repository: `${match[1]}/${match[2]}`.toLowerCase(), number: Number(match[3]), url: `https://github.com/${match[1]}/${match[2]}/pull/${match[3]}` }
      : null;
  } catch {
    return null;
  }
}

const prId = (pr: RoundPrRef): string => `${pr.repository}#${pr.number}`;

const commentMarker = (prev: RoundPrRef, next: RoundPrRef): string => `<!-- elanous:round-pr-superseded ${prId(prev)} -> ${prId(next)} -->`;

function roundPrSupersedeComment(input: { runId: string | null; round: number; prev?: RoundPrRef; next: RoundPrRef }): string {
  return `${input.prev ? `${commentMarker(input.prev, input.next)}\n` : ''}Supervisor round ${input.round}${input.runId ? ` of ${input.runId}` : ''}: superseded by #${input.next.number} (${input.next.url}) — same run and goal, the rework round opened a new PR. Branch preserved.`;
}

/**
 * One tracker per supervised run. `record(results, round)` after each round: for every goal whose newest PR
 * differs from a PR an earlier round of this run opened, the earlier one is superseded exactly once —
 * only while it is an open draft, unmerged, without a protected label, in the same repository.
 */
export function createRoundPrTracker(input: {
  runId: string | null;
  adapters: RoundPrAdapters;
  observe?: (event: string, data: Record<string, unknown>) => void;
}) {
  const byGoal = new Map<string, Array<{ ref: RoundPrRef; merged: boolean; round: number }>>();
  const handled = new Set<string>();
  // The link comment is written once per PR even when the close after it fails and is retried next round.
  const commented = new Set<string>();
  const emit = (event: string, data: Record<string, unknown>): void => {
    try { (input.observe ?? ((e, d) => debug.log('self-dev.supervisor', e, d)))(event, data); } catch { /* observation must not interrupt supervision */ }
  };

  const supersede = (prev: RoundPrRef, next: RoundPrRef, round: number): SupersedeOutcome => {
    const base = { round, prevPr: prev.number, pr: next.number };
    if (prev.repository !== next.repository) return { kind: 'kept', ...base, reason: 'other-repository' };
    if (prId(prev) === prId(next)) return { kind: 'kept', ...base, reason: 'same-pr' };
    let view: RoundPrView | null = null;
    try { view = input.adapters.view(prev); } catch { view = null; }
    if (!view) return { kind: 'kept', ...base, reason: 'view-unobserved' };
    if (view.state !== 'OPEN' || view.mergedAt) return { kind: 'kept', ...base, reason: `state:${view.mergedAt ? 'MERGED' : view.state}` };
    if (!view.isDraft) return { kind: 'kept', ...base, reason: 'not-draft' };
    const held = view.labels.find((label) => PROTECTED_LABELS.has(label));
    if (held) return { kind: 'kept', ...base, reason: `label:${held}` };
    // Label first: a closed but unlabelled PR would fall outside every later sweep (draft-sweep rule).
    let labelled = view.labels.includes(SUPERSEDED_LABEL);
    if (!labelled) {
      try { labelled = input.adapters.addLabel(prev, SUPERSEDED_LABEL); } catch { labelled = false; }
    }
    if (!labelled) return { kind: 'kept', ...base, reason: 'label-failed' };
    const id = prId(prev);
    if (view.comments.some((body) => body.includes(commentMarker(prev, next)))) commented.add(id);
    if (!commented.has(id)) {
      let ok = false;
      try { ok = input.adapters.comment(prev, roundPrSupersedeComment({ runId: input.runId, round, prev, next })); } catch { ok = false; }
      if (!ok) return { kind: 'kept', ...base, reason: 'comment-failed' };
      commented.add(id);
    }
    let closed = false;
    try { closed = input.adapters.close(prev); } catch { closed = false; }
    return closed ? { kind: 'superseded', ...base } : { kind: 'kept', ...base, reason: 'close-failed' };
  };

  /** Unfinished supersedes, keyed by the earlier PR; `next` stays the first successor so retries link the same PR. */
  const pending = new Map<string, { prev: { ref: RoundPrRef; merged: boolean }; next: RoundPrRef }>();

  return {
    /** Record one round's results, then (re)try every unfinished supersede — even when this round has no PR. */
    record(results: readonly SelfDevJobResult[], round: number): RoundPrOutcome[] {
      const outcomes: RoundPrOutcome[] = [];
      for (const result of results) {
        const ref = roundPrRef(result.prUrl);
        if (!ref) continue;
        const key = resumeKey(result.feature);
        const seen = byGoal.get(key) ?? [];
        // A PR already seen in this run is never a new successor — only a new PR is.
        const known = seen.find((entry) => prId(entry.ref) === prId(ref));
        if (known) {
          known.merged ||= result.merged === true;
          // A carried (skipped) shard is not a new round's work.
          if (result.resumeDisposition !== 'skip' && known.round < round) {
            outcomes.push({ kind: 'continued', round, prevPr: known.ref.number, pr: ref.number });
            emit('round-pr-continued', { runId: input.runId, round, prevPr: known.ref.number, pr: ref.number });
          }
          continue;
        }
        // A carried result this run has not seen before was opened by an earlier process — not this run's PR,
        // so it is neither recorded nor allowed to supersede anything.
        if (result.resumeDisposition === 'skip') continue;
        // Only PRs opened in an earlier round are superseded — never a sibling of the same round.
        for (const prev of seen) {
          const id = prId(prev.ref);
          if (prev.round >= round || handled.has(id) || pending.has(id)) continue;
          if (prev.merged) {
            handled.add(id);
            outcomes.push({ kind: 'kept', round, prevPr: prev.ref.number, pr: ref.number, reason: 'merged' });
            continue;
          }
          pending.set(id, { prev, next: ref });
        }
        seen.push({ ref, merged: result.merged === true, round });
        byGoal.set(key, seen);
      }
      for (const [id, { prev: entry, next }] of [...pending]) {
        const prev = entry.ref;
        // A result may have reported the earlier PR merged after it was queued — re-checked right before any write.
        const outcome: SupersedeOutcome = entry.merged
          ? { kind: 'kept', round, prevPr: prev.number, pr: next.number, reason: 'merged' }
          : supersede(prev, next, round);
        outcomes.push(outcome);
        // Retry only what was not observed or not applied; a decided keep/supersede is final for this run.
        if (outcome.kind === 'superseded' || !/^(?:view-unobserved|label-failed|comment-failed|close-failed)$/.test(outcome.reason)) {
          handled.add(id);
          pending.delete(id);
        }
        if (outcome.kind === 'superseded') {
          emit('round-pr-superseded', { runId: input.runId, round, prevPr: prev.number, pr: next.number });
        } else {
          emit('round-pr-supersede-kept', { runId: input.runId, round, prevPr: prev.number, pr: next.number, reason: outcome.reason });
        }
      }
      return outcomes;
    },
  };
}

function ghEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(https?|all|no)_proxy$/i.test(k)) env[k] = v;
  return env;
}

/** Real gh adapters: proxy variables removed, App identity when available (never the personal login by choice). */
export async function defaultRoundPrAdapters(deps: {
  appToken?: () => string | null;
  run?: (args: string[], env: Record<string, string>) => { status: number | null; stdout: string };
  inTest?: () => boolean;
} = {}): Promise<RoundPrAdapters> {
  const env = ghEnv();
  let tokenSource: () => string | null = () => null;
  try {
    tokenSource = deps.appToken ?? (await import('../auth/github-app-token.js')).githubAutomationToken;
  } catch { /* no App credential module — every write refuses */ }
  const freshToken = (): string | null => { try { return tokenSource(); } catch { return null; } };
  const gh = (args: string[], token?: string | null) => {
    const callEnv = { ...env };
    if (token) callEnv.GH_TOKEN = token;
    return deps.run
      ? deps.run(args, callEnv)
      : spawnSync('gh', args, { encoding: 'utf8', env: callEnv as NodeJS.ProcessEnv, timeout: 30_000 });
  };
  // Writes (label · comment · close) run only as the automation App — the token is fetched per write, so a
  // token that was missing or expired earlier in the run recovers; without it the write refuses and is retried.
  // Reads may use the machine login.
  const write = (op: string, pr: RoundPrRef, args: string[]): boolean => {
    const token = freshToken();
    if (!token) {
      try { debug.log('self-dev.supervisor', 'round-pr-write-refused', { op, pr: pr.number, reason: 'no-app-token' }); } catch { /* fail-open */ }
      return false;
    }
    return gh(args, token).status === 0;
  };
  const inTest = deps.inTest ?? ((): boolean => process.env.NODE_ENV === 'test');
  return {
    view(pr) {
      if (inTest()) return null;
      const out = gh(['pr', 'view', String(pr.number), '--repo', pr.repository, '--json', 'state,isDraft,labels,mergedAt,comments'], freshToken());
      if (out.status !== 0) return null;
      try {
        const parsed = JSON.parse(out.stdout) as { state?: unknown; isDraft?: unknown; labels?: unknown; mergedAt?: unknown; comments?: unknown };
        if (typeof parsed.state !== 'string' || typeof parsed.isDraft !== 'boolean' || !Array.isArray(parsed.labels)) return null;
        const labels = parsed.labels.map((label) => (label as { name?: unknown })?.name);
        if (labels.some((name) => typeof name !== 'string')) return null;
        // Unverifiable comments make the whole view unobserved — no write may follow it.
        if (!Array.isArray(parsed.comments)) return null;
        const comments = parsed.comments.map((comment) => (comment as { body?: unknown })?.body);
        if (comments.some((body) => typeof body !== 'string')) return null;
        return { state: parsed.state, isDraft: parsed.isDraft, labels: labels as string[], mergedAt: typeof parsed.mergedAt === 'string' && parsed.mergedAt ? parsed.mergedAt : null, comments: comments as string[] };
      } catch {
        return null;
      }
    },
    addLabel(pr, label) {
      return !inTest() && write('label', pr, ['pr', 'edit', String(pr.number), '--repo', pr.repository, '--add-label', label]);
    },
    comment(pr, body) {
      return !inTest() && write('comment', pr, ['pr', 'comment', String(pr.number), '--repo', pr.repository, '--body', body]);
    },
    close(pr) {
      return !inTest() && write('close', pr, ['pr', 'close', String(pr.number), '--repo', pr.repository]);
    },
  };
}
