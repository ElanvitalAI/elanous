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
import { gitAt, SMART_MERGE_IDENTITY } from '../git-fs/smart-run.js';

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

/**
 * LAND10-FINISHER-WAIT (대표 11-28 18:1x «head 바뀌었다고 영수 무효 = 부당»): the PR-own change with its surroundings dropped —
 * file headers (minus `index` blob ids) and the `+` / `-` lines of each hunk, whitespace kept. Context lines and hunk
 * positions are gone, so main editing a line next to the PR's hunk does not change it (stable patch-id does: it hashes context).
 */
export function ownChangeLines(diff: string): string {
  const out: string[] = [];
  let inHunk = false;
  for (const l of diff.split('\n')) {
    if (l.startsWith('diff --git ')) { inHunk = false; out.push(l); continue; }
    if (l.startsWith('@@')) { inHunk = true; continue; }
    if (inHunk) { if (l.startsWith('+') || l.startsWith('-') || l.startsWith('\\')) out.push(l); continue; }
    if (!l.startsWith('index ')) out.push(l);
  }
  return out.join('\n');
}

export type CarryProof = { ok: true; merges: number } | { ok: false; reason: string };

/**
 * May a receipt measured on `oldHead` stand for `newHead`? (receipt key = the PR-own change · the head is only recorded)
 * Yes ⇔ ① `oldHead` is an ancestor of `newHead` (no rewrite) · ② every commit in oldHead..newHead outside main is a
 * two-parent merge (no own commit after the receipt) · ③ the PR-own change lines (ownChangeLines of
 * diff(merge-base(main, head), head)) are identical. ③ is what «the merge is clean» means for the PR: the own diff is taken
 * against the merged main, so any resolution that deviates from «main ⊕ the same PR change» (-X ours, a dropped or edited
 * hunk, a hand fix in the merge) shows up there and fails it. A structural / rerere resolution that keeps both sides
 * passes — measured 11-28: 9 of 15 smart-merge heads re-pregated with the PR-own lines unchanged (6 of them union-resolved).
 */
export function carryProof(git: GitRun, oldHead: string, newHead: string, mainRef = 'origin/main'): CarryProof {
  const o = rev(git, oldHead); const n = rev(git, newHead); const m = rev(git, mainRef);
  if (!o || !n || !m) return { ok: false, reason: 'unreadable head or main' };
  if (o === n) return { ok: true, merges: 0 };
  if (git(['merge-base', '--is-ancestor', o, n]).status !== 0) return { ok: false, reason: 'old head is not an ancestor (rewritten)' };
  const rl = git(['rev-list', '--parents', n, `^${o}`, `^${m}`]);
  if (rl.status !== 0) return { ok: false, reason: 'rev-list failed' };
  const commits = rl.stdout.split('\n').map(s => s.trim()).filter(Boolean).map(s => s.split(/\s+/));
  for (const [c, ...parents] of commits) if (parents.length !== 2) return { ok: false, reason: `own commit ${c!.slice(0, 12)} after the receipt` };
  const a = prDelta(git, o, mainRef); const b = prDelta(git, n, mainRef);
  if ('error' in a) return { ok: false, reason: a.error };
  if ('error' in b) return { ok: false, reason: b.error };
  if (ownChangeLines(a.diff) !== ownChangeLines(b.diff)) return { ok: false, reason: 'PR-own change differs' };
  return { ok: true, merges: commits.length };
}

const carries = new Map<string, CarryProof>();
/** LAND10-FINISHER-WAIT · SIM-RECEIPT-CARRY: `carryProof` on the repo at `repo`, memo per process (heads are immutable; main
 *  only matters through the merges between them) — the one door the land graph (pregate receipts) and the judge (sim world
 *  receipts) both ask «does the receipt of `oldHead` stand for `head`». */
export function carryProofAt(repo: string, oldHead: string, head: string, mainRef = 'origin/main'): CarryProof {
  const key = `${repo}\0${mainRef}\0${oldHead}\0${head}`;
  if (!carries.has(key)) carries.set(key, carryProof(gitAt(repo, { timeoutMs: 60_000 }), oldHead, head, mainRef));
  return carries.get(key)!;
}
export const carriesOwnDiff = (repo: string, oldHead: string, head: string, mainRef = 'origin/main'): boolean => carryProofAt(repo, oldHead, head, mainRef).ok;

export type LandedIn = { ok: true; via: 'ancestor' | 'squash'; commit: string } | { ok: false; reason: string };
/**
 * SIM-RECEIPT-CARRY: does the tree built from `treeRef` carry PR `pr`'s landed head `head`? Yes ⇔ `head` is an ancestor
 * (merge landing) · or a first-parent commit of `treeRef` that names «(#pr)» is the squash of it — its own change lines
 * (ownChangeLines of diff(parent, commit)) equal the PR-own change of `head` against that parent (the carryProof ③ rule).
 * A squash landing never makes the PR head an ancestor, so the ancestor test alone refused every landed PR (11-28 · the
 * butler's own scene runs said «this tree does not contain …» for #40705 · #40707 on a build that had both).
 */
export function landedIn(git: GitRun, pr: number, head: string, treeRef: string): LandedIn {
  const h = rev(git, head); const t = rev(git, treeRef);
  if (!h) return { ok: false, reason: `head ${head.slice(0, 12)} unreadable` };
  if (!t) return { ok: false, reason: `tree ${treeRef.slice(0, 12)} unreadable` };
  if (git(['merge-base', '--is-ancestor', h, t]).status === 0) return { ok: true, via: 'ancestor', commit: h };
  const log = git(['log', '--first-parent', '--format=%H', '-F', `--grep=(#${pr})`, '-n', '5', t]);
  const candidates = log.status === 0 ? log.stdout.split('\n').map(x => x.trim()).filter(x => SHA40.test(x)) : [];
  for (const c of candidates) {
    const parent = rev(git, `${c}^1`);
    if (!parent) continue;
    const squash = git(['diff', '--no-ext-diff', '--no-color', '--binary', parent, c]);
    const own = prDelta(git, h, parent);
    if (squash.status === 0 && !('error' in own) && ownChangeLines(squash.stdout) === ownChangeLines(own.diff)) return { ok: true, via: 'squash', commit: c };
  }
  return { ok: false, reason: candidates.length ? `commit ${candidates.map(c => c.slice(0, 12)).join('·')} of #${pr} is not this head's PR-own change` : `no commit of #${pr} on ${t.slice(0, 12)}` };
}

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
