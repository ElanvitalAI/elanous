/**
 * SMART-MERGE ④ revert guard — before any automatic merge / rebuild is pushed, the result may remove from main only
 * what the PR itself removes.
 *
 * S: a finisher squash once silently reverted ~500 lines of other PRs (#40355 — caught late by the stale-base guard).
 * C: the stale-base guard (src/land-guard/stale-base-revert.ts) is a heuristic over recent blame; an automatic resolver
 *    needs an exact rule it can check on its own output before the push.
 * A: removed(main → result) − removed(own base → own head), per file, as a line multiset. Any foreign removal of a
 *    non-trivial line (≥ minLines per file, or a whole file the PR never deleted) aborts with the evidence.
 */
import type { GitRun } from '../git-fs/smart-run.js';

export interface ForeignRemoval { file: string; lines: number; sample: string[]; wholeFile?: boolean }
export interface RevertGuardResult { ok: boolean; foreign: ForeignRemoval[]; removedLines: number; card?: string }

/** Removed lines per file of `git diff -U0 a b` (content multiset · trivial lines like `}` or blanks skipped). */
export function removedLines(unifiedZero: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let file = '';
  for (const line of unifiedZero.split('\n')) {
    if (line.startsWith('--- ')) { file = line === '--- /dev/null' ? '' : line.slice(4).replace(/^a\//, ''); continue; }
    if (line.startsWith('+++ ') || line.startsWith('@@')) continue;
    if (line.startsWith('-') && file) {
      const text = line.slice(1);
      const list = out.get(file) ?? []; list.push(text); out.set(file, list);
    }
  }
  return out;
}

/** Deleted files a..b · null when git failed (the guard then fails closed). */
const deletedFiles = (git: GitRun, a: string, b: string): Set<string> | null => {
  const r = git(['diff', '--name-only', '-z', '--diff-filter=D', '--no-renames', a, b]);
  return r.status === 0 ? new Set(r.stdout.split('\0').filter(Boolean)) : null;
};

/**
 * `mainRef` = the main tip the result is built on · `result` = commit or tree being pushed ·
 * `ownBase..ownHead` = the PR's own change (merge-base..head, or stack parent..child for a rebuild).
 */
export type OwnChange = { ownBase: string; ownHead: string } | { ownRevs: readonly string[] };
export function revertGuard(git: GitRun, o: { mainRef: string; result: string; minLines?: number } & OwnChange): RevertGuardResult {
  const minLines = o.minLines ?? 3;
  const res = git(['diff', '-U0', '--no-color', '--no-renames', o.mainRef, o.result]);
  // Own change: one range, or (stack rebuild) the own commits' patches — `rev-list` args like [head, ^main, ^parent].
  const own = 'ownRevs' in o
    ? git(['log', '-p', '-U0', '--no-merges', '--no-color', '--no-renames', '--format=', ...o.ownRevs])
    : git(['diff', '-U0', '--no-color', '--no-renames', o.ownBase, o.ownHead]);
  if (res.status !== 0 || own.status !== 0) {
    return { ok: false, foreign: [], removedLines: 0, card: `REFUSE revert-guard: diff unreadable (${(res.stderr || own.stderr).trim().slice(0, 120)}) — fail closed` };
  }
  const removed = removedLines(res.stdout);
  const ownRemoved = removedLines(own.stdout);
  const resDeleted = deletedFiles(git, o.mainRef, o.result);
  let ownDeleted: Set<string> | null;
  if ('ownRevs' in o) {
    const r = git(['log', '--no-merges', '--diff-filter=D', '--name-only', '--no-renames', '--format=', '-z', ...o.ownRevs]);
    ownDeleted = r.status === 0 ? new Set(r.stdout.split('\0').map(x => x.trim()).filter(Boolean)) : null;
  } else ownDeleted = deletedFiles(git, o.ownBase, o.ownHead);
  if (!resDeleted || !ownDeleted) return { ok: false, foreign: [], removedLines: 0, card: 'REFUSE revert-guard: deleted-file list unreadable — fail closed, nothing pushed' };
  const foreign: ForeignRemoval[] = [];
  let total = 0;
  for (const [file, lines] of removed) {
    total += lines.length;
    if (resDeleted.has(file) && !ownDeleted.has(file)) { foreign.push({ file, lines: lines.length, sample: lines.slice(0, 3), wholeFile: true }); continue; }
    const budget = new Map<string, number>();
    for (const l of ownRemoved.get(file) ?? []) budget.set(l, (budget.get(l) ?? 0) + 1);
    const extra: string[] = [];
    for (const l of lines) { const n = budget.get(l) ?? 0; if (n > 0) budget.set(l, n - 1); else extra.push(l); }
    if (extra.length >= minLines) foreign.push({ file, lines: extra.length, sample: extra.slice(0, 3) });
  }
  for (const file of resDeleted) if (!ownDeleted.has(file) && !removed.has(file)) foreign.push({ file, lines: 0, sample: [], wholeFile: true });
  foreign.sort((a, b) => b.lines - a.lines);
  if (!foreign.length) return { ok: true, foreign, removedLines: total };
  const n = foreign.reduce((s, f) => s + f.lines, 0);
  const card = [
    `REFUSE revert-guard: the automatic result would remove ${n} line(s) of main that are not in the PR's own change (${'ownRevs' in o ? o.ownRevs.map(r => r.slice(0, 13)).join(' ') : `${o.ownBase.slice(0, 12)}..${o.ownHead.slice(0, 12)}`}).`,
    ...foreign.slice(0, 8).map(f => `  - ${f.file}: ${f.wholeFile ? 'whole file deleted' : `${f.lines} line(s)`}${f.sample.length ? ` e.g. ${JSON.stringify(f.sample[0]!.trim().slice(0, 80))}` : ''}`),
    'Nothing was pushed. Resolve by hand keeping main\'s lines, or say in the PR body that the removal is intended.',
  ].join('\n');
  return { ok: false, foreign, removedLines: total, card };
}
