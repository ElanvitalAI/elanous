/**
 * SIBLING-RESYNC-ON-MERGE (0.2.21 P0) — when one harness PR merges, the open sibling PRs that touch the
 * same paths learn it «now», not when their gate fails or main-sync breaks.
 *
 * Measured 2026-10-07: 76% of launches overlap an open PR or a running run on the same paths.
 *
 * Delivery reuses existing channels only:
 *   · live owning run  → one supervisor memo in its control inbox (`elanous self send --memo` path)
 *   · no live run      → the registered `elanous:needs-rebase` label (QUIET-PR-COMMENTS: never a comment)
 *
 * Cost bound (#24893 review should-fix ①, measured 186 open PRs → 186 `…/files` calls per merge):
 *   · prefilter   — a PR already carrying the marker is skipped before any file fetch
 *   · priority    — PRs whose branch shares path tokens with the merged files are fetched first
 *   · fetch cap   — at most `maxFetch` file inventories per merge (config `harness.siblingResync.maxFetch`, default 40)
 *   · concurrency — at most `fetchConcurrency` (default 6) fetches in flight
 *
 * Pure core: every side effect is an injected adapter so tests never touch GitHub or the inbox.
 */
import { debug } from '../debug/log.js';
import type { ControlMemoPayload } from '../harness/control-inbox.js';

export const SIBLING_RESYNC_CATEGORY = 'self-implement.sibling-resync';
export const SIBLING_RESYNC_DEFAULT_CAP = 10;
export const SIBLING_RESYNC_DEFAULT_MAX_FETCH = 40;
export const SIBLING_RESYNC_DEFAULT_FETCH_CONCURRENCY = 6;
export const SIBLING_RESYNC_MARKER_LABEL = 'elanous:needs-rebase';
const HARNESS_BRANCH_PREFIX = 'self-impl/';

/** An open PR before its file inventory is fetched. */
export interface SiblingResyncCandidate {
  readonly number: number;
  readonly branch: string;
  readonly labels: readonly string[];
}

export interface SiblingResyncPr extends SiblingResyncCandidate {
  /** `undefined` means the file list could not be proven complete — such a PR never qualifies. */
  readonly files: readonly string[] | undefined;
}

export type SiblingRunTarget =
  | { readonly alive: true; readonly runId: string; readonly spaceId: string }
  | { readonly alive: false; readonly runId?: string; readonly reason: string };

export interface SiblingResyncAdapters {
  /** Open PRs (draft or ready) against the default branch, without files. A rejection is not an empty list. */
  listOpenPrs(): Promise<readonly SiblingResyncCandidate[]>;
  /** One PR's files; `undefined` (or a rejection) means unknown and that PR never qualifies. */
  prFiles(number: number): Promise<readonly string[] | undefined>;
  /** The merged PR's files; `undefined` means unknown and nothing is sent. */
  mergedFiles(): Promise<readonly string[] | undefined>;
  resolveRun(pr: SiblingResyncPr): Promise<SiblingRunTarget>;
  sendResync(target: { runId: string; spaceId: string }, memo: ControlMemoPayload): Promise<void> | void;
  addMarker(prNumber: number, label: string): Promise<void> | void;
}

export interface SiblingResyncResult {
  readonly requested: readonly number[];
  readonly marked: readonly number[];
  readonly failed: readonly number[];
  readonly skippedOverCap: readonly number[];
  /** Already marked before any fetch — not fetched. */
  readonly skippedPrefilter: readonly number[];
  /** Over the per-merge fetch cap — not fetched. */
  readonly skippedFetchCap: readonly number[];
  readonly filesFetched: number;
  readonly durationMs: number;
  readonly reason?: string;
}

export function siblingResyncMemo(merged: number, overlap: readonly string[]): ControlMemoPayload {
  const shown = overlap.slice(0, 5).join(', ');
  const more = overlap.length > 5 ? ` (+${overlap.length - 5} more)` : '';
  return {
    version: 1,
    kind: 'sibling-resync',
    urgency: 'normal',
    body: `[sibling-resync] Sibling PR #${merged} just merged into main touching the same paths: ${shown}${more}. `
      + 'Before continuing: git fetch origin main, rebase this branch onto origin/main (resolve conflicts keeping both intents), then re-run the gate on your changed files.',
  };
}

/** Exact path intersection; a PR without a provable file list is never a sibling. */
export function overlappingFiles(merged: readonly string[], sibling: readonly string[] | undefined): string[] {
  if (!sibling || sibling.length === 0) return [];
  const mergedSet = new Set(merged);
  return [...new Set(sibling.filter((file) => mergedSet.has(file)))].sort();
}

const GENERIC_TOKENS = new Set(['src', 'test', 'tests', 'index', 'scripts', 'docs', 'goals', 'goal', 'self', 'impl', 'apps', 'main', 'json', 'html', 'spec', 'types', 'lib']);

/** Lower-case path tokens (dir segments and file stems split on `-_.`), generic and short ones removed. */
export function pathTokens(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 3 && !GENERIC_TOKENS.has(token) && !/^\d+$/.test(token)));
}

/** Shared path tokens between the merged files and a branch name — a cheap ordering hint, never a filter. */
export function branchAffinity(mergedTokens: ReadonlySet<string>, branch: string): number {
  let score = 0;
  for (const token of pathTokens(branch)) if (mergedTokens.has(token)) score += 1;
  return score;
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

export async function requestSiblingResync(input: {
  merged: { number: number };
  adapters: SiblingResyncAdapters;
  cap?: number;
  maxFetch?: number;
  fetchConcurrency?: number;
  log?: (category: string, event: string, data: Record<string, unknown>) => void;
  now?: () => number;
}): Promise<SiblingResyncResult> {
  const { merged, adapters } = input;
  const now = input.now ?? Date.now;
  const startedAt = now();
  const cap = nonNegativeInt(input.cap, SIBLING_RESYNC_DEFAULT_CAP);
  const maxFetch = nonNegativeInt(input.maxFetch, SIBLING_RESYNC_DEFAULT_MAX_FETCH);
  const concurrency = Math.max(1, nonNegativeInt(input.fetchConcurrency, SIBLING_RESYNC_DEFAULT_FETCH_CONCURRENCY));
  const log = input.log ?? ((category, event, data) => debug.log(category, event, data));
  const emit = (event: string, data: Record<string, unknown>) => {
    try { log(SIBLING_RESYNC_CATEGORY, event, { merged: merged.number, ...data }); } catch { /* fail-soft */ }
  };
  const requested: number[] = [];
  const marked: number[] = [];
  const failed: number[] = [];
  const skippedOverCap: number[] = [];
  const skippedPrefilter: number[] = [];
  const skippedFetchCap: number[] = [];
  let filesFetched = 0;
  const result = (reason?: string): SiblingResyncResult => ({
    requested, marked, failed, skippedOverCap, skippedPrefilter, skippedFetchCap, filesFetched,
    durationMs: Math.max(0, now() - startedAt), ...(reason ? { reason } : {}),
  });
  let mergedFiles: readonly string[] | undefined;
  let open: readonly SiblingResyncCandidate[];
  try {
    mergedFiles = await adapters.mergedFiles();
    if (!mergedFiles || mergedFiles.length === 0) {
      const out = result('merged-files-unknown');
      emit('skipped', { reason: out.reason, durationMs: out.durationMs });
      return out;
    }
    open = await adapters.listOpenPrs();
  } catch (error) {
    const out = result('inventory-failed');
    emit('skipped', { reason: out.reason, error: String(error), durationMs: out.durationMs });
    return out;
  }
  const mergedTokens = new Set<string>();
  for (const file of mergedFiles) for (const token of pathTokens(file)) mergedTokens.add(token);
  const candidates: { pr: SiblingResyncCandidate; affinity: number }[] = [];
  for (const pr of open) {
    if (pr.number === merged.number || !pr.branch.startsWith(HARNESS_BRANCH_PREFIX)) continue;
    // Already marked: the quiet signal is in place, and a re-fetch would only re-confirm it.
    if (pr.labels.includes(SIBLING_RESYNC_MARKER_LABEL)) { skippedPrefilter.push(pr.number); continue; }
    candidates.push({ pr, affinity: branchAffinity(mergedTokens, pr.branch) });
  }
  // Most likely siblings first; ties go to the newest PR (most likely to have a live run).
  candidates.sort((a, b) => b.affinity - a.affinity || b.pr.number - a.pr.number);
  const toFetch = candidates.slice(0, maxFetch);
  skippedFetchCap.push(...candidates.slice(maxFetch).map(({ pr }) => pr.number));
  const fetched = await mapBounded(toFetch, concurrency, async ({ pr }): Promise<SiblingResyncPr> => {
    let files: readonly string[] | undefined;
    try { files = await adapters.prFiles(pr.number); } catch { files = undefined; }
    filesFetched += 1;
    return { ...pr, files };
  });
  const siblings = fetched
    .map((pr) => ({ pr, overlap: overlappingFiles(mergedFiles!, pr.files) }))
    .filter(({ overlap }) => overlap.length > 0)
    .sort((a, b) => a.pr.number - b.pr.number);
  for (const [index, { pr, overlap }] of siblings.entries()) {
    if (index >= cap) { skippedOverCap.push(pr.number); continue; }
    let target: SiblingRunTarget;
    try {
      target = await adapters.resolveRun(pr);
    } catch (error) {
      target = { alive: false, reason: `run-resolution-failed: ${String(error)}` };
    }
    if (target.alive) {
      try {
        await adapters.sendResync({ runId: target.runId, spaceId: target.spaceId }, siblingResyncMemo(merged.number, overlap));
        requested.push(pr.number);
        emit('requested', { sibling: pr.number, runId: target.runId, spaceId: target.spaceId, overlap });
        continue;
      } catch (error) {
        // A live run we could not reach still needs to be visible — fall through to the quiet marker.
        emit('send-failed', { sibling: pr.number, runId: target.runId, error: String(error) });
      }
    }
    try {
      await adapters.addMarker(pr.number, SIBLING_RESYNC_MARKER_LABEL);
      marked.push(pr.number);
      emit('marked', { sibling: pr.number, label: SIBLING_RESYNC_MARKER_LABEL, reason: target.alive ? 'send-failed' : target.reason, ...(target.runId ? { runId: target.runId } : {}), overlap });
    } catch (error) {
      failed.push(pr.number);
      emit('mark-failed', { sibling: pr.number, error: String(error) });
    }
  }
  const out = result();
  emit('summary', {
    siblings: siblings.length, requested, marked, failed, skippedOverCap, cap,
    filesFetched, skippedPrefilter: skippedPrefilter.length, skippedFetchCap: skippedFetchCap.length, maxFetch, concurrency,
    durationMs: out.durationMs,
  });
  return out;
}
