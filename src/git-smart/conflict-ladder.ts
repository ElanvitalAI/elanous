/**
 * SMART-MERGE ③ conflict resolution ladder — runs on a worktree that stopped with conflicts (merge or rebase step).
 *
 *   (a) rerere      the merge/rebase runs with rerere on (`RERERE_ARGS`) — recorded resolutions replay before we look.
 *   (b) structural  per conflict hunk (diff3 markers): both sides only insert lines → union (theirs then ours, duplicates
 *                   once · `mergeAppendOnly` from pr-land-conflict-merge) · one-line list/regex/registry where both sides
 *                   insert at a point → both insertions · import-only hunks → import union (named specifiers merged).
 *   (c) LLM capsule only the remaining hunks, through the existing hunk resolver (`resolveConflictByHunks` /
 *                   `defaultLlmResolve`) with the model picked by difficulty — async, so the land tick launches it as a
 *                   detached capsule (`eln land smart-merge <pr> --llm`); the tests decide afterwards (pregate on the
 *                   new head before any land).
 *   (d) card        whatever is left, with the exact hunks.
 * Never drops a side wholesale: every structural rule keeps both sides' lines; the revert guard checks the final tree.
 * Every file goes through the same ladder (CEO 11-27 10:3x — no security special-casing; same-host federation is trusted).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GitRun } from '../git-fs/smart-run.js';
import { mergeAppendOnly } from '../cli/pr-land-conflict-merge.js';
import { hasLadderConflictMarkers } from './conflict-markers.js';

/**
 * `-c` flags every smart-merge merge / cherry-pick runs with: rerere REPLAYS recorded resolutions (autoUpdate stages them),
 * diff3 markers for the ladder. Recorded resolutions come from hands resolving in worktrees of the same repository
 * (shared rr-cache; `git config rerere.enabled true` on the repo) — the smart-merge never records its own (structural or
 * LLM) resolutions: `forgetOwnResolutions` runs before every commit, so a dry run, a guard refusal or a resolution the
 * tests later reject is never replayed.
 */
export const RERERE_ARGS = ['-c', 'rerere.enabled=true', '-c', 'rerere.autoUpdate=true', '-c', 'merge.conflictStyle=diff3'] as const;
/** Commits after a resolution run with rerere off. */
export const NO_RERERE_ARGS = ['-c', 'rerere.enabled=false'] as const;
/** Drop rerere's bookkeeping for the current stop (preimages without postimage) so nothing of ours is recorded later. */
export const forgetOwnResolutions = (git: GitRun): void => { git(['-c', 'rerere.enabled=true', 'rerere', 'clear']); };

export interface Hunk { start: number; end: number; ours: string[]; base: string[]; theirs: string[] }
export interface FileConflict { path: string; text: string; hunks: Hunk[] }
export type HunkRule = 'append-union' | 'inline-insert' | 'import-union';
export interface LadderResult {
  resolved: Array<{ path: string; rule: HunkRule | 'rerere' | 'llm' }>;
  remaining: FileConflict[];
}

/** diff3 conflict hunks of a file (null = unbalanced markers or a hunk without a base section). */
export function parseDiff3(text: string): Hunk[] | null {
  const lines = text.split('\n');
  const hunks: Hunk[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!/^<{7}(?: |$)/.test(lines[i]!)) { i++; continue; }
    const start = i; const ours: string[] = []; const base: string[] = []; const theirs: string[] = [];
    let part: 'ours' | 'base' | 'theirs' = 'ours'; let sawBase = false;
    for (i++; i < lines.length; i++) {
      const l = lines[i]!;
      if (/^\|{7}(?: |$)/.test(l) && part === 'ours') { part = 'base'; sawBase = true; continue; }
      if (/^={7}$/.test(l) && part === 'base') { part = 'theirs'; continue; }
      if (/^>{7}(?: |$)/.test(l) && part === 'theirs') break;
      if (/^(<{7}|={7}|>{7})/.test(l)) return null;
      (part === 'ours' ? ours : part === 'base' ? base : theirs).push(l);
    }
    if (i >= lines.length || !sawBase) return null;
    hunks.push({ start, end: i, ours, base, theirs });
    i++;
  }
  return hunks;
}

const block = (ls: readonly string[]) => (ls.length ? `${ls.join('\n')}\n` : '');

/** Single-line insertion of `changed` relative to `base`: [position in base, inserted text] · null if not a pure insertion. */
function inlineInsertion(base: string, changed: string): [number, string] | null {
  if (changed.length <= base.length) return null;
  let p = 0;
  while (p < base.length && base[p] === changed[p]) p++;
  let s = 0;
  while (s < base.length - p && base[base.length - 1 - s] === changed[changed.length - 1 - s]) s++;
  if (p + s !== base.length) return null;
  const ins = changed.slice(p, changed.length - s);
  // The same insertion can sit at several points (`'s|mart-merge', 's|upervisors'`): slide it left to the first
  // alignment where it is a whole list item (`'smart-merge', ` before `'supervisors'`).
  for (let k = 0; k <= Math.min(p, ins.length); k++) {
    if (k > 0 && base.slice(p - k, p) !== ins.slice(ins.length - k)) break;
    const cand = k ? ins.slice(ins.length - k) + ins.slice(0, ins.length - k) : ins;
    if (LIST_ITEM.test(cand)) return [p - k, cand];
  }
  return [p, ins];
}

const LIST_ITEM = /^(?:,\s*|\|)[\w'"`@$./:-]+[\w'"`)\]]*$|^[\w'"`@$./:-]+[\w'"`]*(?:,\s*|\|)$/;
const IMPORT_LINE = /^\s*(import|export)\s.*\bfrom\s+['"][^'"]+['"];?\s*$|^\s*import\s+['"][^'"]+['"];?\s*$/;
const NAMED = /^\s*import\s+(type\s+)?\{([^}]*)\}\s+from\s+(['"][^'"]+['"]);?\s*$/;

/**
 * Three-way union of two import blocks: what either side added is kept, what either side removed from the base stays
 * removed (named specifiers per module merged into one line; identical lines once).
 */
export function importUnion(theirs: readonly string[], ours: readonly string[], base: readonly string[] = []): string[] | null {
  const all = [...theirs, ...ours];
  if (!all.every(l => IMPORT_LINE.test(l) || !l.trim())) return null;
  const namesOf = (lines: readonly string[]) => {
    const m = new Map<string, Set<string>>();
    for (const l of lines) { const x = NAMED.exec(l); if (x) { const k = `${x[1] ? 'type ' : ''}${x[3]}`; const set = m.get(k) ?? new Set<string>(); for (const n of x[2]!.split(',').map(y => y.trim()).filter(Boolean)) set.add(n); m.set(k, set); } }
    return m;
  };
  const bN = namesOf(base); const oN = namesOf(ours); const tN = namesOf(theirs);
  const dropped = (k: string, n: string) => !!bN.get(k)?.has(n) && (!oN.get(k)?.has(n) || !tN.get(k)?.has(n));
  const lineDropped = (l: string) => base.includes(l) && (!ours.includes(l) || !theirs.includes(l));
  const out: string[] = []; const named = new Map<string, { idx: number; names: string[]; type: boolean; mod: string }>();
  for (const l of all) {
    if (!l.trim()) continue;
    const m = NAMED.exec(l);
    if (m) {
      const key = `${m[1] ? 'type ' : ''}${m[3]}`;
      const names = m[2]!.split(',').map(x => x.trim()).filter(n => n && !dropped(key, n));
      const cur = named.get(key);
      const render = (e: { names: string[]; type: boolean; mod: string }) => `import ${e.type ? 'type ' : ''}{ ${e.names.join(', ')} } from ${e.mod};`;
      if (cur) { for (const n of names) if (!cur.names.includes(n)) cur.names.push(n); out[cur.idx] = render(cur); continue; }
      if (!names.length) continue;
      const e = { idx: out.length, names, type: !!m[1], mod: m[3]! };
      named.set(key, e);
      out.push(render(e));
      continue;
    }
    if (!lineDropped(l) && !out.includes(l)) out.push(l);
  }
  return out;
}

/** (b) one hunk → resolved lines · null when no structural rule applies. Every rule keeps both sides. */
export function resolveHunkStructurally(path: string, h: Hunk): { lines: string[]; rule: HunkRule } | null {
  const merged = mergeAppendOnly(block(h.base), block(h.ours), block(h.theirs), path, { anyPath: true });
  if (merged.verdict === 'append-only') return { lines: merged.content === '' ? [] : merged.content.replace(/\n$/, '').split('\n'), rule: 'append-union' };
  // Line by line when the three sides have the same line count (e.g. two registry literals edited in one hunk).
  if (h.base.length >= 1 && h.ours.length === h.base.length && h.theirs.length === h.base.length) {
    const out: string[] = [];
    for (let i = 0; i < h.base.length; i++) {
      const b = h.base[i]!; const ol = h.ours[i]!; const tl = h.theirs[i]!;
      if (ol === tl) { out.push(ol); continue; }
      if (ol === b) { out.push(tl); continue; }
      if (tl === b) { out.push(ol); continue; }
      const o = inlineInsertion(b, ol); const t = inlineInsertion(b, tl);
      // Only list / union items: each insertion is a separator-led (or -trailed) element — `, 'x'` · `|x` — never
      // operators like `!` (both sides adding `!` would merge into `!!`, flipping the intent).
      if (!(o && t && LIST_ITEM.test(o[1]) && LIST_ITEM.test(t[1]) && o[1] !== t[1])) { out.length = 0; break; }
      out.push(o[0] === t[0] ? b.slice(0, t[0]) + t[1] + o[1] + b.slice(t[0])
        : o[0] < t[0] ? b.slice(0, o[0]) + o[1] + b.slice(o[0], t[0]) + t[1] + b.slice(t[0])
          : b.slice(0, t[0]) + t[1] + b.slice(t[0], o[0]) + o[1] + b.slice(o[0]));
    }
    if (out.length === h.base.length) return { lines: out, rule: 'inline-insert' };
  }
  if (/\.[cm]?[jt]sx?$/.test(path)) {
    const u = importUnion(h.theirs, h.ours, h.base);
    if (u && h.base.every(l => IMPORT_LINE.test(l) || !l.trim())) {
      // Base imports removed by either side stay removed only if BOTH removed them; otherwise they were kept by a side.
      return { lines: u, rule: 'import-union' };
    }
  }
  return null;
}

/** Apply (b) to one conflicted file text. Returns the new text and whether every hunk was resolved. */
export function resolveFileStructurally(path: string, text: string): { text: string; rules: HunkRule[]; left: Hunk[] } | null {
  const hunks = parseDiff3(text);
  if (!hunks) return null;
  const lines = text.split('\n'); const out: string[] = []; const rules: HunkRule[] = []; const left: Hunk[] = [];
  let cur = 0;
  for (const h of hunks) {
    for (let i = cur; i < h.start; i++) out.push(lines[i]!);
    const r = resolveHunkStructurally(path, h);
    if (r) { out.push(...r.lines); rules.push(r.rule); } else { for (let i = h.start; i <= h.end; i++) out.push(lines[i]!); left.push(h); }
    cur = h.end + 1;
  }
  for (let i = cur; i < lines.length; i++) out.push(lines[i]!);
  return { text: out.join('\n'), rules, left };
}

export const unmergedPaths = (git: GitRun): string[] =>
  git(['diff', '--name-only', '-z', '--diff-filter=U']).stdout.split('\0').filter(Boolean);

/**
 * (a)+(b) on a stopped worktree: rerere already ran inside the merge/rebase; resolve what is left structurally, `git add`
 * every fully resolved file. Files that are not text with diff3 markers (binary · delete/modify) stay in `remaining`.
 */
export function runLadderSync(git: GitRun, worktree: string): LadderResult {
  const resolved: LadderResult['resolved'] = [];
  const remaining: FileConflict[] = [];
  for (const path of unmergedPaths(git)) {
    let text: string;
    try { text = readFileSync(join(worktree, path), 'utf8'); } catch { remaining.push({ path, text: '', hunks: [] }); continue; }
    const r = resolveFileStructurally(path, text);
    if (!r) { remaining.push({ path, text, hunks: [] }); continue; }
    if (r.left.length === 0 && r.rules.length > 0) {
      writeFileSync(join(worktree, path), r.text);
      git(['add', '--', path]);
      resolved.push({ path, rule: r.rules[0]! });
      continue;
    }
    if (r.rules.length) writeFileSync(join(worktree, path), r.text);
    remaining.push({ path, text: r.rules.length ? r.text : text, hunks: r.left });
  }
  return { resolved, remaining };
}

/** (c) LLM resolver for one conflicted file text (markers in, resolved text out). */
export type LlmResolve = (path: string, conflicted: string, worktree?: string) => Promise<string>;

/** (c) on what (a)/(b) left: each file through `llm`, rejected if markers remain. Adds resolved files to the index. */
export async function runLadderLlm(git: GitRun, worktree: string, remaining: readonly FileConflict[], llm: LlmResolve): Promise<LadderResult> {
  const resolved: LadderResult['resolved'] = []; const left: FileConflict[] = [];
  for (const f of remaining) {
    if (!f.hunks.length) { left.push(f); continue; }
    let out: string;
    try { out = await llm(f.path, f.text, worktree); } catch { left.push(f); continue; }
    if (!out.trim() || hasLadderConflictMarkers(out)) { left.push(f); continue; }
    writeFileSync(join(worktree, f.path), out);
    git(['add', '--', f.path]);
    resolved.push({ path: f.path, rule: 'llm' });
  }
  return { resolved, remaining: left };
}

/** (d) the card text: exact hunks of what is left (bounded). */
export function conflictCard(what: string, remaining: readonly FileConflict[], maxChars = 3000): string {
  const parts = [`needs-finisher: ${what} — ${remaining.length} file(s) the ladder (rerere → structural → LLM) could not resolve:`];
  for (const f of remaining) {
    parts.push(`  ${f.path}${f.hunks.length ? ` · ${f.hunks.length} hunk(s)` : ' · not a text conflict (binary / delete-modify)'}`);
    for (const h of f.hunks.slice(0, 2)) {
      parts.push(`    @@ line ${h.start + 1}`, ...h.ours.slice(0, 4).map(l => `    < ${l}`), ...h.theirs.slice(0, 4).map(l => `    > ${l}`));
    }
  }
  const text = parts.join('\n');
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n  …` : text;
}
