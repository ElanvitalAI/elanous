/**
 * SMART-MERGE ① PR-own delta — one definition of «what this PR changes», used by receipts, review and guards.
 *
 * S: a head move used to look like a new change — receipts died on every main merge (fixed by #40358 patch-id), the
 *    review delta read raw old..new and refused «delta diff over 20,562 chars» after a main merge, and the stale-base
 *    guard explained a refusal without saying which lines were the PR's own.
 * C: three copies of «diff merge-base..head | patch-id --stable» lived in land-graph-cli, review-carry and the
 *    virtual-rebase proof; none of them could say how two heads differ in PR-own terms.
 * A: `prDelta(head)` = diff(merge-base(main, head), head) + its stable patch-id · `deltaSince(old, new)` = the range-diff
 *    of the two PR-own changes (each squashed onto its own merge-base), empty when the patch-ids match — so a head that
 *    only merged main has a zero delta.
 */
import type { GitRun } from '../git-fs/smart-run.js';
import { SMART_MERGE_IDENTITY } from '../git-fs/smart-run.js';

export const SHA40 = /^[0-9a-f]{40}$/;

/** First field of `git patch-id --stable` output (lowercase sha) · null when absent / malformed. */
export function patchIdFromOutput(stdout: string): string | null {
  const id = stdout.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  return SHA40.test(id) ? id : null;
}

/** Stable patch-id of a unified diff text · null for an empty diff or a git failure. */
export function stablePatchId(git: GitRun, diff: string): string | null {
  if (!diff.trim()) return null;
  const r = git(['patch-id', '--stable'], { input: diff.endsWith('\n') ? diff : `${diff}\n` });
  return r.status === 0 ? patchIdFromOutput(r.stdout) : null;
}

const rev = (git: GitRun, ref: string): string | null => {
  const r = git(['rev-parse', '--verify', `${ref}^{commit}`]);
  const s = r.stdout.trim().toLowerCase();
  return r.status === 0 && SHA40.test(s) ? s : null;
};

export interface PrDelta { head: string; mergeBase: string; diff: string; patchId: string | null; files: string[] }
export type DeltaError = { error: string };

/** The PR-own change of `head` against `mainRef`: diff(merge-base, head) · patch-id · touched files. */
export function prDelta(git: GitRun, head: string, mainRef = 'origin/main'): PrDelta | DeltaError {
  const h = rev(git, head);
  if (!h) return { error: `head ${head.slice(0, 12)} unreadable` };
  const m = rev(git, mainRef);
  if (!m) return { error: `${mainRef} unreadable` };
  const mb = git(['merge-base', m, h]);
  const mergeBase = mb.stdout.trim().toLowerCase();
  if (mb.status !== 0 || !SHA40.test(mergeBase)) return { error: 'no merge-base with main' };
  return deltaBetween(git, mergeBase, h);
}

/** The change `base..head` as a PR-own delta (used when the own base is not merge-base(main), e.g. a stack parent). */
export function deltaBetween(git: GitRun, base: string, head: string): PrDelta | DeltaError {
  const d = git(['diff', '--no-ext-diff', '--no-color', '--binary', base, head]);
  if (d.status !== 0) return { error: `diff ${base.slice(0, 12)}..${head.slice(0, 12)} failed` };
  const names = git(['diff', '--name-only', '-z', base, head]);
  return { head, mergeBase: base, diff: d.stdout, patchId: stablePatchId(git, d.stdout), files: names.stdout.split('\0').filter(Boolean) };
}

/** A diff without its position / blob lines (`index …`, `@@ -a,b +c,d @@` numbers) — content and whitespace kept. */
export const diffBody = (diff: string): string => diff.split('\n').filter(l => !l.startsWith('index ')).map(l => (l.startsWith('@@') ? l.replace(/^@@ [^@]* @@/, '@@') : l)).join('\n');

export interface DeltaSince {
  /** true ⇔ the PR-own change is identical (same stable patch-id) — e.g. only main was merged in. */
  same: boolean;
  oldPatchId: string | null; newPatchId: string | null;
  /** `git range-diff` of the two PR-own changes ('' when same). */
  rangeDiff: string;
  chars: number;
}

/**
 * How the PR-own change moved from `oldHead` to `newHead`. Each head's own change is squashed into one synthetic commit
 * on its own merge-base (objects only · no ref moves), so main merges, rebases and conflict resolutions all compare as
 * «patch vs patch». Merge commits with resolution changes are inside the squash — nothing is silently dropped.
 */
export function deltaSince(git: GitRun, oldHead: string, newHead: string, mainRef = 'origin/main'): DeltaSince | DeltaError {
  const a = prDelta(git, oldHead, mainRef);
  if ('error' in a) return a;
  const b = prDelta(git, newHead, mainRef);
  if ('error' in b) return b;
  // Same = same stable patch-id AND the same diff body (patch-id ignores whitespace — indentation can carry meaning).
  if (a.patchId && a.patchId === b.patchId && diffBody(a.diff) === diffBody(b.diff)) return { same: true, oldPatchId: a.patchId, newPatchId: b.patchId, rangeDiff: '', chars: 0 };
  if (!a.diff.trim() && !b.diff.trim()) return { same: true, oldPatchId: null, newPatchId: null, rangeDiff: '', chars: 0 };
  const squash = (d: PrDelta, label: string): string | null => {
    const r = git([...SMART_MERGE_IDENTITY, 'commit-tree', `${d.head}^{tree}`, '-p', d.mergeBase, '-m', label]);
    const s = r.stdout.trim().toLowerCase();
    return r.status === 0 && SHA40.test(s) ? s : null;
  };
  const sa = squash(a, `PR-own @ ${a.head.slice(0, 12)}`);
  const sb = squash(b, `PR-own @ ${b.head.slice(0, 12)}`);
  if (!sa || !sb) return { error: 'squash commit failed' };
  // One squashed commit per side: a high creation factor always pairs them, so the output is the diff of the two patches.
  const rd = git(['range-diff', '--no-color', '--creation-factor=1000', `${a.mergeBase}..${sa}`, `${b.mergeBase}..${sb}`]);
  if (rd.status !== 0) return { error: `range-diff failed: ${rd.stderr.trim().slice(0, 120)}` };
  return { same: false, oldPatchId: a.patchId, newPatchId: b.patchId, rangeDiff: rd.stdout, chars: rd.stdout.length };
}
