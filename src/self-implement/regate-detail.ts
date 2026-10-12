/**
 * HOST-REGATE-REASON-LOST (2nd · 2026-10-12): a host-regate failure must say «why» on the ledger.
 *
 * The first repair (#26215) put `hostRegateFailure` on the pr-terminal row but kept only the first 300 characters,
 * and the gate's own `run()` cut every git/gh error to its first 300 characters as well. A git merge lists one
 * `CONFLICT` line per file and gh puts the GraphQL reason at the end, so a head cut loses exactly the cause
 * (run-caaf045f · PR #26472: the autopsy could not tell a conflict from a gate failure).
 *
 * The detail is bounded (ledger rows are append-only and replayed) but keeps both ends.
 */
export const HOST_REGATE_DETAIL_MAX = 4096;

/** Keep `text` within `max` characters, preserving its head (an eighth) and its tail (the rest). */
export function clipRegateDetail(text: string, max = HOST_REGATE_DETAIL_MAX): string {
  if (text.length <= max) return text;
  const marker = ` …[${text.length - max} chars elided]… `;
  const head = Math.floor(max / 8);
  const tail = Math.max(0, max - head - marker.length);
  return text.slice(0, head) + marker + text.slice(text.length - tail);
}

/** Files named by `git merge` CONFLICT lines (`CONFLICT (content): Merge conflict in <path>` and the rename/delete forms). */
export function parseConflictFiles(text: string): string[] {
  const files = new Set<string>();
  for (const raw of text.split('\n')) {
    const line = /^CONFLICT \(([^)]*)\): (.*)$/.exec(raw);
    if (!line) continue;
    const rest = line[2]!;
    const inPath = /Merge conflict in (.+)$/.exec(rest);
    // modify/delete · rename/delete · file/directory name the path first; other free text is not a path.
    const path = inPath ? inPath[1] : /^(?:modify\/delete|rename\/delete)$/.test(line[1]!)
      ? /^(.+?) (?:deleted|renamed) in /.exec(rest)?.[1]
      : undefined;
    if (path) files.add(path);
  }
  return [...files].sort();
}

export type MergeFailureKind = 'base-modified' | 'head-moved' | 'conflict' | 'branch-policy' | 'other';

/** Classify a `gh pr merge` failure so a reader can tell a race from a conflict from a policy block without the raw text. */
export function classifyMergeFailure(detail: string, expectedHead?: string, actualHead?: string | null): MergeFailureKind {
  if (/base branch was modified/i.test(detail)) return 'base-modified';
  if (/head branch was modified/i.test(detail)) return 'head-moved';
  if (expectedHead && actualHead && expectedHead !== actualHead) return 'head-moved';
  if (/required status|review is required|protected branch|branch policy|not authorized|merge queue/i.test(detail)) return 'branch-policy';
  if (/\bconflicts?\b/i.test(detail) && !/\bno conflicts?\b/i.test(detail)) return 'conflict';
  return 'other';
}

/** One host-regate failure. The optional facts are filled for the pr-head, merge-conflict and merge steps. */
export interface HostRegateFailure {
  step: string;
  detail: string;
  expectedHead?: string;
  actualHead?: string | null;
  conflictFiles?: string[];
  /** Number omitted from conflictFiles when the ledger's 200-path bound is reached. */
  conflictFilesOmitted?: number;
  mergeFailureKind?: MergeFailureKind;
}

/** The optional facts of a failure, copied only when well-formed (ledger rows come back from disk). */
export function regateFailureFacts(failure: unknown): Omit<HostRegateFailure, 'step' | 'detail'> {
  if (!failure || typeof failure !== 'object') return {};
  const f = failure as Record<string, unknown>;
  const sha = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value);
  const kinds: readonly MergeFailureKind[] = ['base-modified', 'head-moved', 'conflict', 'branch-policy', 'other'];
  const conflictFiles = Array.isArray(f.conflictFiles) ? f.conflictFiles.filter((p): p is string => typeof p === 'string') : undefined;
  const priorOmitted = Number.isSafeInteger(f.conflictFilesOmitted) && (f.conflictFilesOmitted as number) > 0 ? f.conflictFilesOmitted as number : 0;
  const conflictFilesOmitted = Math.max(0, (conflictFiles?.length ?? 0) - 200) + priorOmitted;
  return {
    ...(sha(f.expectedHead) ? { expectedHead: f.expectedHead } : {}),
    ...(sha(f.actualHead) || f.actualHead === null ? { actualHead: f.actualHead as string | null } : {}),
    ...(conflictFiles ? { conflictFiles: conflictFiles.slice(0, 200) } : {}),
    ...(conflictFilesOmitted > 0 ? { conflictFilesOmitted } : {}),
    ...(typeof f.mergeFailureKind === 'string' && kinds.includes(f.mergeFailureKind as MergeFailureKind) ? { mergeFailureKind: f.mergeFailureKind as MergeFailureKind } : {}),
  };
}
