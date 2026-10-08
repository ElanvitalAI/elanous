/**
 * RUN-TTL (0.2.21 P1 · first piece · FINDING #24712) — an open harness PR has a «time to landing».
 *
 * Open self-impl PRs linger for days while main moves (~80 merges/day), so an old draft rots silently.
 * Past `tools.selfImplement.runTtlHours` (default 24) since its last commit, the sweep makes one pre-emptive move:
 *   · live owning run → one resync memo in its control inbox (same path as SIBLING-RESYNC #24893/#24899),
 *                       at most once per (PR, head sha) — a rebase moves the head and re-arms it
 *   · no live run     → the registered `elanous:needs-rebase` label, once (QUIET-PR-COMMENTS: never a comment)
 *
 * Mode `tools.selfImplement.runTtl.mode`: `shadow` (default) only logs what it would do; `live` writes.
 * Cost bound: a PR opened inside the TTL is still inside its own time-to-landing and is never fetched
 * (`freshByCreation`), already-marked PRs without a live run are skipped before any fetch, at most `maxFetch` last-commit lookups per sweep with `concurrency` in flight, and at most `cap` actions.
 *
 * Pure core: every side effect is an injected adapter so tests never touch GitHub or the inbox.
 */
import { debug } from '../debug/log.js';
import type { ControlMemoPayload } from '../harness/control-inbox.js';
import { SIBLING_RESYNC_MARKER_LABEL, type SiblingRunTarget } from './sibling-resync.js';

export const RUN_TTL_CATEGORY = 'self-implement.run-ttl';
export const RUN_TTL_DEFAULT_HOURS = 24;
export const RUN_TTL_DEFAULT_CAP = 30;
export const RUN_TTL_DEFAULT_MAX_FETCH = 60;
export const RUN_TTL_DEFAULT_CONCURRENCY = 6;
export const RUN_TTL_MARKER_LABEL = SIBLING_RESYNC_MARKER_LABEL;
const HARNESS_BRANCH_PREFIX = 'self-impl/';
const KEEP_LABEL = 'elanous:keep';

export type RunTtlMode = 'shadow' | 'live';

export interface RunTtlCandidate {
  readonly number: number;
  readonly branch: string;
  readonly labels: readonly string[];
  readonly createdAt: string;
  readonly headSha: string;
}

export interface RunTtlAdapters {
  /** Open PRs against the default branch. A rejection is not an empty list. */
  listOpenPrs(): Promise<readonly RunTtlCandidate[]>;
  /** ISO time of the head commit; `undefined` (or a rejection) means unknown and the PR is left alone. */
  lastCommitAt(pr: RunTtlCandidate): Promise<string | undefined>;
  resolveRun(pr: RunTtlCandidate): Promise<SiblingRunTarget>;
  sendMemo(target: { runId: string; spaceId: string }, memo: ControlMemoPayload): Promise<void> | void;
  addLabel(prNumber: number, label: string): Promise<void> | void;
  /** Memo dedupe by `<pr>:<headSha>`. Omitted ⇒ no dedupe. */
  memoSent?(key: string): boolean;
  recordMemoSent?(key: string): void;
}

export interface RunTtlResult {
  readonly mode: RunTtlMode;
  readonly ttlHours: number;
  /** Open self-impl PRs considered (keep-labelled excluded). */
  readonly considered: number;
  readonly freshByCreation: number;
  readonly fetched: number;
  readonly fresh: number;
  readonly unknown: readonly number[];
  readonly stale: readonly number[];
  /** Memo sent (live) or would be sent (shadow). */
  readonly memo: readonly number[];
  /** Label added (live) or would be added (shadow). */
  readonly label: readonly number[];
  readonly alreadyMarked: readonly number[];
  readonly alreadyMemoed: readonly number[];
  /** Owning run lookup failed — left alone (a failed lookup is not a dead run). */
  readonly unresolved?: readonly number[];
  readonly skippedOverCap: readonly number[];
  readonly skippedFetchCap: readonly number[];
  readonly failed: readonly number[];
  readonly durationMs: number;
  readonly reason?: string;
}

export function runTtlMemo(ageHours: number, ttlHours: number): ControlMemoPayload {
  return {
    version: 1,
    kind: 'run-ttl-resync',
    urgency: 'normal',
    body: `[run-ttl] This PR's last commit is ${Math.floor(ageHours)}h old (time-to-landing ${ttlHours}h) while main keeps moving. `
      + 'Before continuing: git fetch origin main, rebase this branch onto origin/main (resolve conflicts keeping both intents), then re-run the gate on your changed files.',
  };
}

async function mapBounded<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

const nonNegativeInt = (value: number | undefined, fallback: number): number =>
  value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : fallback;

export async function runRunTtlSweep(input: {
  adapters: RunTtlAdapters;
  mode?: RunTtlMode;
  ttlHours?: number;
  cap?: number;
  maxFetch?: number;
  concurrency?: number;
  now?: () => number;
  log?: (category: string, event: string, data: Record<string, unknown>) => void;
}): Promise<RunTtlResult> {
  const { adapters } = input;
  const now = input.now ?? Date.now;
  const startedAt = now();
  const mode: RunTtlMode = input.mode === 'live' ? 'live' : 'shadow';
  const ttlHours = typeof input.ttlHours === 'number' && Number.isFinite(input.ttlHours) && input.ttlHours > 0
    ? input.ttlHours : RUN_TTL_DEFAULT_HOURS;
  const cap = nonNegativeInt(input.cap, RUN_TTL_DEFAULT_CAP);
  const maxFetch = nonNegativeInt(input.maxFetch, RUN_TTL_DEFAULT_MAX_FETCH);
  const concurrency = Math.max(1, nonNegativeInt(input.concurrency, RUN_TTL_DEFAULT_CONCURRENCY));
  const ttlMs = ttlHours * 3_600_000;
  const log = input.log ?? ((category, event, data) => debug.log(category, event, data));
  const emit = (event: string, data: Record<string, unknown>) => {
    try { log(RUN_TTL_CATEGORY, event, { mode, ...data }); } catch { /* fail-soft */ }
  };
  let considered = 0;
  let freshByCreation = 0;
  let fetched = 0;
  let fresh = 0;
  const unknown: number[] = [];
  const stale: number[] = [];
  const memo: number[] = [];
  const label: number[] = [];
  const alreadyMarked: number[] = [];
  const alreadyMemoed: number[] = [];
  const unresolved: number[] = [];
  const skippedOverCap: number[] = [];
  const skippedFetchCap: number[] = [];
  const failed: number[] = [];
  const result = (reason?: string): RunTtlResult => ({
    mode, ttlHours, considered, freshByCreation, fetched, fresh, unknown, stale, memo, label, alreadyMarked,
    alreadyMemoed, unresolved, skippedOverCap, skippedFetchCap, failed, durationMs: Math.max(0, now() - startedAt),
    ...(reason ? { reason } : {}),
  });
  const summary = (out: RunTtlResult): RunTtlResult => {
    emit('summary', {
      ttlHours, cap, maxFetch, concurrency, considered, freshByCreation, fetched, fresh,
      unknown: unknown.length, stale: stale.length, memo: memo.length, label: label.length,
      alreadyMarked: alreadyMarked.length, alreadyMemoed: alreadyMemoed.length, unresolved: unresolved.length,
      skippedOverCap: skippedOverCap.length, skippedFetchCap: skippedFetchCap.length, failed: failed.length,
      memoPrs: memo, labelPrs: label, durationMs: out.durationMs, ...(out.reason ? { reason: out.reason } : {}),
    });
    return out;
  };

  let open: readonly RunTtlCandidate[];
  try {
    open = await adapters.listOpenPrs();
  } catch (error) {
    emit('skipped', { reason: 'inventory-failed', error: String(error) });
    return summary(result('inventory-failed'));
  }
  const nowMs = now();
  const pending: { pr: RunTtlCandidate; target: SiblingRunTarget }[] = [];
  for (const pr of open) {
    if (!pr.branch.startsWith(HARNESS_BRANCH_PREFIX) || pr.labels.includes(KEEP_LABEL)) continue;
    considered += 1;
    const created = Date.parse(pr.createdAt);
    // A PR opened inside the TTL is inside its own time-to-landing — no fetch needed.
    if (Number.isFinite(created) && nowMs - created < ttlMs) { freshByCreation += 1; continue; }
    let target: SiblingRunTarget;
    try { target = await adapters.resolveRun(pr); } catch (error) {
      // A failed lookup is not proof the run is gone — never label (or memo) an unresolved PR.
      unresolved.push(pr.number);
      emit('run-unresolved', { pr: pr.number, error: String(error) });
      continue;
    }
    // Dead run + marker already present: the quiet signal is in place («once»), nothing to fetch.
    if (!target.alive && pr.labels.includes(RUN_TTL_MARKER_LABEL)) { alreadyMarked.push(pr.number); continue; }
    pending.push({ pr, target });
  }
  // Oldest PR first: the most likely to have rotted.
  pending.sort((a, b) => (Date.parse(a.pr.createdAt) || 0) - (Date.parse(b.pr.createdAt) || 0) || a.pr.number - b.pr.number);
  const toFetch = pending.slice(0, maxFetch);
  skippedFetchCap.push(...pending.slice(maxFetch).map(({ pr }) => pr.number));
  const dated = await mapBounded(toFetch, concurrency, async (entry) => {
    let at: string | undefined;
    try { at = await adapters.lastCommitAt(entry.pr); } catch { at = undefined; }
    fetched += 1;
    const ms = at ? Date.parse(at) : NaN;
    return { ...entry, ageMs: Number.isFinite(ms) ? nowMs - ms : undefined };
  });
  const stalePrs: (typeof dated[number] & { ageMs: number })[] = [];
  for (const entry of dated) {
    if (entry.ageMs === undefined) { unknown.push(entry.pr.number); continue; }
    if (entry.ageMs < ttlMs) { fresh += 1; continue; }
    stale.push(entry.pr.number);
    stalePrs.push({ ...entry, ageMs: entry.ageMs });
  }
  stalePrs.sort((a, b) => b.ageMs - a.ageMs || a.pr.number - b.pr.number);
  let actions = 0;
  for (const { pr, target, ageMs } of stalePrs) {
    const ageHours = ageMs / 3_600_000;
    const key = `${pr.number}:${pr.headSha}`;
    if (target.alive) {
      let already: boolean | undefined;
      try { already = adapters.memoSent?.(key) ?? false; } catch (error) {
        // Without the journal «once» cannot be proven — skip rather than risk a repeat memo.
        failed.push(pr.number);
        emit('memo-journal-failed', { pr: pr.number, stage: 'read', error: String(error) });
        continue;
      }
      if (already) { alreadyMemoed.push(pr.number); continue; }
    }
    if (!target.alive && pr.labels.includes(RUN_TTL_MARKER_LABEL)) { alreadyMarked.push(pr.number); continue; }
    if (actions >= cap) { skippedOverCap.push(pr.number); continue; }
    actions += 1;
    if (target.alive) {
      if (mode === 'shadow') {
        memo.push(pr.number);
        emit('would-memo', { pr: pr.number, runId: target.runId, spaceId: target.spaceId, ageHours: Math.floor(ageHours) });
        continue;
      }
      // Journal first: a memo that cannot be recorded is not sent, so «once per (PR, head sha)» holds.
      try { adapters.recordMemoSent?.(key); } catch (error) {
        failed.push(pr.number);
        emit('memo-journal-failed', { pr: pr.number, stage: 'write', error: String(error) });
        continue;
      }
      try {
        await adapters.sendMemo({ runId: target.runId, spaceId: target.spaceId }, runTtlMemo(ageHours, ttlHours));
        memo.push(pr.number);
        emit('memo', { pr: pr.number, runId: target.runId, spaceId: target.spaceId, ageHours: Math.floor(ageHours) });
        continue;
      } catch (error) {
        // A live run we could not reach still needs to be visible — fall through to the quiet marker.
        emit('memo-failed', { pr: pr.number, runId: target.runId, error: String(error) });
        if (pr.labels.includes(RUN_TTL_MARKER_LABEL)) { alreadyMarked.push(pr.number); continue; }
      }
    }
    const reason = target.alive ? 'memo-failed' : target.reason;
    if (mode === 'shadow') {
      label.push(pr.number);
      emit('would-label', { pr: pr.number, label: RUN_TTL_MARKER_LABEL, reason, ageHours: Math.floor(ageHours) });
      continue;
    }
    try {
      await adapters.addLabel(pr.number, RUN_TTL_MARKER_LABEL);
      label.push(pr.number);
      emit('label', { pr: pr.number, label: RUN_TTL_MARKER_LABEL, reason, ageHours: Math.floor(ageHours) });
    } catch (error) {
      failed.push(pr.number);
      emit('label-failed', { pr: pr.number, error: String(error) });
    }
  }
  return summary(result());
}
