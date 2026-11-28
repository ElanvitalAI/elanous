/**
 * LAND10-AUTOFIX-LANE — the land finisher fixes mechanical pregate REDs itself (CEO 11-27 «착지 10/h 는 정책·구조 문제»).
 *
 * S: 11-27→28 night landed 2–8/h (target ≥ 10). Of the RED receipts in PREGATE-RED, most were rules-and-ratchets
 *    (NUMGUARD «numeric-bound» without a source comment), diff-check whitespace, public-export identifiers or merge-main —
 *    each waited for the author's hand. The finisher re-ran pregate but never fixed anything.
 * C: these reds name the exact lines and the exact fix; no judgement is needed, only a deterministic edit.
 * A: a RED receipt whose every red step is mechanical → one fix commit on the PR branch (plain push, never force) →
 *    new head → the finisher's pregate lane re-measures it. Fixers:
 *      whitespace  diff-check «trailing whitespace» / «new blank line at EOF» → strip on the PR-added lines of the named files
 *      numguard    NUMGUARD «numeric-bound: <line>» → a provenance comment line above each PR-added line with that text
 *                  (`// 출처: #<PR> …` — the form test/rules-contract.test.ts sourceComment accepts)
 *      quote-key   public-export «private redaction would change code identifiers: <file>:<line> <name>» → quote that
 *                  identifier where it is a property key (object literal · interface/type member · class field · enum)
 *      merge-main  is not here: finishKindFor sends a merge-main-only RED to the SMART-MERGE refresh.
 *    Anything else (another failing test · a shorthand / dotted use of the identifier · a line inside a template or JSX
 *    text · no PR-added line matches) = semantic → nothing is pushed, the author gets the pregate-red card.
 * Safety: code files must stay the same program — the comment-free print of the AST before and after must be equal
 *    (whitespace · comment edits); a key quote is checked by node kind and a clean re-parse. Push only when the author is
 *    quiet (head commit ≥ AUTHOR_QUIET_MS old · or written by the land graph) and the remote branch is still at the RED head
 *    (checked after fetch and right before the push). One job per PR at a time (the smart-merge PR lock).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { gitAt, SMART_MERGE_IDENTITY, type GitRun } from '../git-fs/smart-run.js';
import { acquirePrLock, lockHolder } from '../git-smart/smart-refresh.js';
import { SHA40 } from '../git-smart/delta.js';
import { AUTOFIX_STEPS } from './finisher.js';

/** The author is «quiet» once the RED head is this old — before that the hand may still be pushing its own fix. */
export const AUTHOR_QUIET_MS = 30 * 60_000; // OPS-RULES «미커밋 WIP 인수 규칙» (11-27): 30분 무응답 writer 는 writer 가 아니다
/** Commit trailer on every autofix commit (the review guard and humans read what was fixed). */
export const AUTOFIX_TRAILER = 'Land-Autofix';

export type AutofixKind = 'whitespace' | 'numguard' | 'quote-key';
export interface AutofixItem { kind: AutofixKind; file?: string; line?: number; text?: string; name?: string; eof?: boolean }
export interface AutofixPlan { items: AutofixItem[]; semantic: string[] }
export interface AppliedFix { kind: AutofixKind; file: string; line: number }

// ── Raw logs ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Minimal ustar reader (PREGATE-RED/<dir>/red.tar holds <step>.raw) — no tar subprocess. Skips pax / AppleDouble entries. */
export function readTar(buf: Uint8Array): Map<string, string> {
  const out = new Map<string, string>();
  const dec = new TextDecoder();
  const field = (h: Uint8Array, a: number, b: number) => dec.decode(h.subarray(a, b)).replace(/\0[\s\S]*$/, '');
  let off = 0;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every(b => b === 0)) break;
    const size = parseInt(field(h, 124, 136).trim() || '0', 8);
    if (!Number.isFinite(size)) break;
    const prefix = field(h, 345, 500);
    const name = (prefix ? `${prefix}/` : '') + field(h, 0, 100);
    const type = h[156];
    off += 512;
    const base = name.replace(/^\.\//, '');
    if ((type === 0 || type === 48 /* '0' */) && !base.split('/').pop()!.startsWith('._')) out.set(base, dec.decode(buf.subarray(off, off + size)));
    off += Math.ceil(size / 512) * 512;
  }
  return out;
}

/** `<step>.raw` of a RED receipt dir: a loose file first, else the red.tar entry. */
export function redRaw(dir: string, step: string): string | null {
  const loose = join(dir, `${step}.raw`);
  try { if (existsSync(loose)) return readFileSync(loose, 'utf8'); } catch { /* fall through */ }
  try { return readTar(readFileSync(join(dir, 'red.tar'))).get(`${step}.raw`) ?? null; } catch { return null; }
}

// ── Parse: RED text → plan ────────────────────────────────────────────────────────────────────────────────────────

/** bun test output → failing tests with the text bun printed before each `(fail)` line (its error block). */
export function failBlocks(text: string): Array<{ name: string; body: string }> {
  const out: Array<{ name: string; body: string }> = [];
  let buf: string[] = [];
  for (const l of text.split('\n')) {
    const m = /^\(fail\) (.*?)(?: \[[\d.]+m?s\])?\s*$/.exec(l);
    if (m) { out.push({ name: m[1]!, body: buf.join('\n') }); buf = []; continue; }
    if (/^\((?:pass|skip|todo)\) /.test(l)) { buf = []; continue; }
    buf.push(l);
  }
  return out;
}

/** The `+   "…",` items of a bun toEqual([]) diff. */
function receivedItems(body: string): string[] {
  const items: string[] = [];
  for (const l of body.split('\n')) {
    const m = /^\+\s+("(?:[^"\\]|\\.)*"),?\s*$/.exec(l);
    if (!m) continue;
    try { items.push(JSON.parse(m[1]!) as string); } catch { items.push(m[1]!); }
  }
  return items;
}

const REDACTION_MSG = /private redaction would change code identifiers: (.+)$/m;
function redactionItems(text: string): AutofixItem[] | null {
  const m = REDACTION_MSG.exec(text);
  if (!m) return null;
  const items: AutofixItem[] = [];
  for (const part of m[1]!.replace(/\s*\(\+\d+ more\)\s*$/, '').split(/,\s*/)) {
    const p = /^(.+?):(\d+) ([A-Za-z_$][\w$]*)$/.exec(part.trim());
    if (p) items.push({ kind: 'quote-key', file: p[1]!, line: Number(p[2]), name: p[3]! });
  }
  return items.length ? items : null;
}

/**
 * The red steps' raw text → what the lane may fix. Fail closed: a red step it cannot read, a failing test it does not
 * know, or a known test with an item it does not know → `semantic` (then nothing is fixed at all).
 */
export function planAutofix(red: ReadonlyArray<{ step: string; text: string | null }>): AutofixPlan {
  const items: AutofixItem[] = [];
  const semantic: string[] = [];
  for (const { step, text } of red) {
    if (!AUTOFIX_STEPS.has(step)) { semantic.push(`${step}: not a mechanical step`); continue; }
    if (text === null) { semantic.push(`${step}: raw log unreadable`); continue; }
    if (step === 'diff-check') {
      let n = 0;
      for (const l of text.split('\n')) {
        const m = /^(.+?):(\d+): (trailing whitespace|new blank line at EOF)\.\s*$/.exec(l);
        if (m) { items.push({ kind: 'whitespace', file: m[1]!, line: Number(m[2]), ...(m[3] === 'new blank line at EOF' ? { eof: true } : {}) }); n++; }
        else if (/^.+?:\d+: .+\.\s*$/.test(l) && !l.startsWith('+')) semantic.push(`diff-check: ${l.trim().slice(0, 120)}`);
      }
      if (!n && !semantic.some(s => s.startsWith('diff-check'))) semantic.push('diff-check: no whitespace item found');
      continue;
    }
    const redaction = redactionItems(text);
    const fails = failBlocks(text);
    if (!fails.length && !redaction) { semantic.push(`${step}: red without a failing test or a redaction message`); continue; }
    if (redaction) items.push(...redaction);
    for (const f of fails) {
      if (REDACTION_MSG.test(f.body)) continue; // its items are above
      const got = receivedItems(f.body);
      if (/\bNUMGUARD\b/.test(f.name) && got.length && got.every(x => x.startsWith('numeric-bound: '))) {
        for (const x of got) items.push({ kind: 'numguard', text: x.slice('numeric-bound: '.length) });
        continue;
      }
      semantic.push(`${step}: ${f.name.slice(0, 140)}`);
    }
  }
  return { items, semantic };
}

// ── Fixers (pure: text in, text out) ──────────────────────────────────────────────────────────────────────────────

const CODE_FILE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i;
const scriptKind = (file: string) => /\.(?:tsx|jsx)$/i.test(file) ? ts.ScriptKind.TSX : /\.(?:js|mjs|cjs)$/i.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
// setParentNodes: fixQuoteKey reads node.parent to tell a property key from any other use of the name
const parse = (file: string, text: string) => ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file)) as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] };
const PRINTER = ts.createPrinter({ removeComments: true });

/** Same program: no new parse error and the comment-free print is identical (catches template / JSX text edits). */
export function sameProgram(file: string, before: string, after: string): boolean {
  if (!CODE_FILE.test(file)) return true;
  const a = parse(file, before); const b = parse(file, after);
  if (b.parseDiagnostics.length > a.parseDiagnostics.length) return false;
  return PRINTER.printFile(a) === PRINTER.printFile(b);
}

/** Strip trailing blanks on the given 1-based lines (and trailing blank lines at EOF when `eof`). null = not the same program. */
export function fixWhitespace(file: string, text: string, lines: ReadonlySet<number>, eof: boolean): { text: string; fixed: number[] } | null {
  const ls = text.split('\n');
  const fixed: number[] = [];
  for (const n of lines) {
    const i = n - 1;
    if (i < 0 || i >= ls.length) continue;
    const s = ls[i]!.replace(/[ \t]+$/, '');
    if (s !== ls[i]) { ls[i] = s; fixed.push(n); }
  }
  let out = ls.join('\n');
  if (eof) { const t = out.replace(/(?:\n[ \t]*)+$/, '\n'); if (t !== out) { out = t; fixed.push(ls.length); } }
  if (!fixed.length) return { text, fixed };
  return sameProgram(file, text, out) ? { text: out, fixed: fixed.sort((a, b) => a - b) } : null;
}

/** A provenance comment line above each given 1-based line (same indent). null = not the same program (template · JSX text). */
export function fixNumguard(file: string, text: string, lines: ReadonlySet<number>, pr: number): { text: string; fixed: number[] } | null {
  const ls = text.split('\n');
  const out: string[] = [];
  const fixed: number[] = [];
  ls.forEach((l, i) => {
    if (lines.has(i + 1)) {
      const prev = out[out.length - 1] ?? '';
      // already carries a source comment right above (an earlier autofix): leave it
      if (!/(?:\/\/|\/\*)\s*(?:출처|근거|source)\s*[:：]/i.test(prev)) {
        out.push(`${/^\s*/.exec(l)![0]}// 출처: #${pr} — 이 PR 이 정한 값 그대로(착지 자동 수리 · NUMGUARD)`);
        fixed.push(i + 1);
      }
    }
    out.push(l);
  });
  const t = out.join('\n');
  if (!fixed.length) return { text, fixed };
  return sameProgram(file, text, t) ? { text: t, fixed } : null;
}

/** Quote identifier `name` on the given 1-based lines where it names a property. Any other use → null (semantic). */
export function fixQuoteKey(file: string, text: string, lines: ReadonlySet<number>, name: string): { text: string; fixed: number[] } | null {
  if (!CODE_FILE.test(file)) return null;
  const sf = parse(file, text);
  const spans: Array<{ start: number; end: number; line: number }> = [];
  let bad = false;
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === name) {
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      if (lines.has(line)) {
        const p = node.parent;
        const isKey = !!p && (ts.isPropertyAssignment(p) || ts.isPropertySignature(p) || ts.isPropertyDeclaration(p)
          || ts.isMethodDeclaration(p) || ts.isMethodSignature(p) || ts.isEnumMember(p) || ts.isGetAccessor(p) || ts.isSetAccessor(p)) && p.name === node;
        const isBindingKey = !!p && ts.isBindingElement(p) && p.propertyName === node;
        if (isKey || isBindingKey) spans.push({ start: node.getStart(sf), end: node.getEnd(), line });
        else bad = true; // shorthand · dotted access · a variable — renaming it changes the program
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (bad || !spans.length) return null;
  let out = text;
  for (const s of [...spans].sort((a, b) => b.start - a.start)) out = `${out.slice(0, s.start)}'${name}'${out.slice(s.end)}`;
  if (parse(file, out).parseDiagnostics.length > sf.parseDiagnostics.length) return null;
  return { text: out, fixed: [...new Set(spans.map(s => s.line))].sort((a, b) => a - b) };
}

// ── PR-added lines ────────────────────────────────────────────────────────────────────────────────────────────────

/** `git diff -U0 base head` → file → 1-based head line numbers the PR added. */
export function addedLines(diff: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  let file = '';
  for (const l of diff.split('\n')) {
    if (l.startsWith('+++ ')) { file = l.startsWith('+++ b/') ? l.slice(6) : ''; continue; }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(l);
    if (h && file) {
      const start = Number(h[1]); const count = h[2] === undefined ? 1 : Number(h[2]);
      const set = out.get(file) ?? new Set<number>();
      for (let k = 0; k < count; k++) set.add(start + k);
      out.set(file, set);
    }
  }
  return out;
}

/**
 * Plan → concrete edits on the head tree. `read(file)` = head content (null = missing). Returns the new contents and
 * what was fixed, or a semantic reason (nothing is written then).
 */
export function editsFor(plan: AutofixPlan, pr: number, added: ReadonlyMap<string, ReadonlySet<number>>, read: (file: string) => string | null):
  { files: Map<string, string>; applied: AppliedFix[] } | { semantic: string } {
  if (plan.semantic.length) return { semantic: plan.semantic.join(' · ') };
  if (!plan.items.length) return { semantic: 'no mechanical item in the RED' };
  const files = new Map<string, string>();
  const applied: AppliedFix[] = [];
  const cur = (f: string) => files.get(f) ?? read(f);
  // whitespace: every PR-added line of a named file (diff --check flags exactly those) · EOF when named
  const ws = new Map<string, { eof: boolean }>();
  for (const it of plan.items) if (it.kind === 'whitespace' && it.file) ws.set(it.file, { eof: (ws.get(it.file)?.eof ?? false) || !!it.eof });
  for (const [file, o] of ws) {
    const text = cur(file);
    if (text === null) return { semantic: `whitespace: ${file} missing on the head` };
    const r = fixWhitespace(file, text, new Set(added.get(file) ?? []), o.eof);
    if (!r) return { semantic: `whitespace: ${file} — the edit would change the program (inside a template / JSX text)` };
    if (!r.fixed.length) return { semantic: `whitespace: ${file} — nothing to strip on the PR's lines` };
    files.set(file, r.text); applied.push(...r.fixed.map(line => ({ kind: 'whitespace' as const, file, line })));
  }
  // numguard: PR-added lines whose trimmed text is the violation text (the ratchet names text, not a place)
  const ng = plan.items.filter(it => it.kind === 'numguard').map(it => it.text ?? '');
  if (ng.length) {
    const want = new Set(ng);
    const hit = new Set<string>();
    for (const [file, set] of added) {
      if (!/^(?:src|apps|scripts|test)\//.test(file)) continue;
      const text = cur(file);
      if (text === null) continue;
      const ls = text.split('\n');
      const lines = new Set([...set].filter(n => want.has((ls[n - 1] ?? '').trim())));
      if (!lines.size) continue;
      const r = fixNumguard(file, text, lines, pr);
      if (!r) return { semantic: `numguard: ${file} — a comment line there would change the program (template / JSX text)` };
      for (const n of lines) hit.add((ls[n - 1] ?? '').trim());
      files.set(file, r.text); applied.push(...r.fixed.map(line => ({ kind: 'numguard' as const, file, line })));
    }
    const missing = [...want].filter(x => !hit.has(x));
    if (missing.length) return { semantic: `numguard: no PR-added line reads «${missing[0]!.slice(0, 80)}»` };
  }
  // quote-key: the named identifier on PR-added lines of the named file
  const qk = new Map<string, Set<string>>();
  for (const it of plan.items) if (it.kind === 'quote-key' && it.file && it.name) qk.set(it.file, (qk.get(it.file) ?? new Set()).add(it.name));
  for (const [file, names] of qk) {
    let text = cur(file);
    if (text === null) return { semantic: `quote-key: ${file} missing on the head` };
    const lines = new Set(added.get(file) ?? []);
    for (const name of names) {
      const r = fixQuoteKey(file, text, lines, name);
      if (!r) return { semantic: `quote-key: ${file} uses «${name}» as more than a property key on the PR's lines (or not on them)` };
      text = r.text; applied.push(...r.fixed.map(line => ({ kind: 'quote-key' as const, file, line })));
    }
    files.set(file, text);
  }
  return { files, applied };
}

// ── Apply on the PR branch ────────────────────────────────────────────────────────────────────────────────────────

export type AutofixResult =
  | { result: 'fixed'; newHead: string; applied: AppliedFix[]; pushed: boolean }
  | { result: 'semantic'; why: string }
  | { result: 'author-active'; why: string }
  | { result: 'head-moved' | 'closed' | 'busy' | 'error'; why: string };

export interface AutofixInput {
  repo: string; pr: number; head: string; branch: string;
  /** The red steps' raw text (planAutofix input). */
  red: ReadonlyArray<{ step: string; text: string | null }>;
  lockDir?: string;
  /** false = compute and verify, do not push (sim / dry). */
  push?: boolean;
  nowMs?: number;
  stillOpen?: () => boolean;
  gitFor?: (cwd: string) => GitRun;
}

const sha = (r: { status: number | null; stdout: string }): string | null => { const s = r.stdout.trim().toLowerCase(); return r.status === 0 && SHA40.test(s) ? s : null; };
const kindCount = (a: readonly AppliedFix[]) => (['whitespace', 'numguard', 'quote-key'] as const).map(k => `${k} ${a.filter(x => x.kind === k).length}`).join(' · ');

export function autofixPr(o: AutofixInput): AutofixResult {
  const plan = planAutofix(o.red);
  if (plan.semantic.length) return { result: 'semantic', why: plan.semantic.join(' · ').slice(0, 400) };
  if (!plan.items.length) return { result: 'semantic', why: 'no mechanical item in the RED' };
  const lockDir = o.lockDir ?? join(tmpdir(), 'git-smart-locks');
  const release = acquirePrLock(lockDir, o.pr);
  if (!release) return { result: 'busy', why: `another smart-merge / autofix holds #${o.pr} (${lockHolder(lockDir, o.pr) ?? '?'})` };
  const mk = o.gitFor ?? ((cwd: string) => gitAt(cwd));
  const repo = mk(o.repo);
  let dir = '';
  let wt = '';
  try {
    const remoteRef = `refs/remotes/origin/${o.branch}`;
    const fetch = repo(['fetch', '-q', 'origin', 'main', `+refs/heads/${o.branch}:${remoteRef}`]);
    if (fetch.status !== 0) return { result: 'error', why: `fetch failed: ${fetch.stderr.trim().slice(0, 120)}` };
    const head = sha(repo(['rev-parse', '--verify', `${remoteRef}^{commit}`]));
    if (!head || head !== o.head.toLowerCase()) return { result: 'head-moved', why: `branch ${o.branch} is at ${head?.slice(0, 12) ?? '?'} (RED was ${o.head.slice(0, 12)})` };
    // The author is quiet: the RED head is old enough, or the land graph wrote it (a smart-merge / earlier autofix).
    const who = repo(['log', '-1', '--format=%ct %ce', head]).stdout.trim().split(' ');
    const ageMs = (o.nowMs ?? Date.now()) - Number(who[0]) * 1000;
    const byLandGraph = who[1] === SMART_MERGE_IDENTITY[3]!.replace('user.email=', '');
    if (!byLandGraph && !(ageMs >= AUTHOR_QUIET_MS)) return { result: 'author-active', why: `head pushed ${Math.max(0, Math.round(ageMs / 60_000))} min ago — the author may still be fixing it` };
    const main = sha(repo(['rev-parse', '--verify', 'origin/main^{commit}']));
    const base = main ? sha(repo(['merge-base', main, head])) : null;
    if (!base) return { result: 'error', why: 'merge-base with origin/main unreadable' };
    const diff = repo(['diff', '-U0', '--no-color', '--no-ext-diff', base, head]);
    if (diff.status !== 0) return { result: 'error', why: 'PR diff unreadable' };
    dir = mkdtempSync(join(tmpdir(), `land-autofix-${o.pr}-`));
    wt = join(dir, 'wt');
    if (repo(['worktree', 'add', '-q', '--detach', wt, head]).status !== 0) return { result: 'error', why: 'worktree add failed' };
    const read = (f: string): string | null => { try { return readFileSync(join(wt, f), 'utf8'); } catch { return null; } };
    const e = editsFor(plan, o.pr, addedLines(diff.stdout), read);
    if ('semantic' in e) return { result: 'semantic', why: e.semantic.slice(0, 400) };
    for (const [f, t] of e.files) writeFileSync(join(wt, f), t);
    const w = mk(wt);
    if (w(['add', '--', ...e.files.keys()]).status !== 0) return { result: 'error', why: 'git add failed' };
    // own edits must not add whitespace errors either
    if (w(['diff', '--cached', '--check']).status !== 0) return { result: 'semantic', why: 'the autofix edit itself fails diff --check' };
    const msg = `autofix(land): mechanical pregate RED on #${o.pr} — ${kindCount(e.applied)}\n\n`
      + `The land graph's autofix lane (LAND10-AUTOFIX-LANE) fixed only the lines the ratchets named:\n`
      + e.applied.map(a => `- ${a.kind} ${a.file}:${a.line}`).slice(0, 40).join('\n') + '\n\n'
      + `${AUTOFIX_TRAILER}: ${kindCount(e.applied)}`;
    const cm = w([...SMART_MERGE_IDENTITY, 'commit', '-q', '--no-verify', '-m', msg]);
    if (cm.status !== 0) return { result: 'error', why: `commit failed: ${(cm.stderr || cm.stdout).trim().slice(0, 120)}` };
    const newHead = sha(w(['rev-parse', 'HEAD']));
    if (!newHead) return { result: 'error', why: 'new head unreadable' };
    if (o.push === false) return { result: 'fixed', newHead, applied: e.applied, pushed: false };
    if (o.stillOpen && !o.stillOpen()) return { result: 'closed', why: `PR #${o.pr} closed during the autofix — nothing pushed` };
    const ls = repo(['ls-remote', 'origin', `refs/heads/${o.branch}`]);
    if (ls.status !== 0) return { result: 'error', why: `ls-remote failed: ${ls.stderr.trim().slice(0, 120)} — nothing pushed` };
    const now = ls.stdout.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
    if (now !== head) return { result: 'head-moved', why: `branch moved to ${now.slice(0, 12) || '?'} during the autofix — nothing pushed` };
    // plain push: a fast-forward of the branch (never force)
    const push = repo(['push', '-q', 'origin', `${newHead}:refs/heads/${o.branch}`]);
    if (push.status !== 0) return { result: 'error', why: `push refused: ${push.stderr.trim().slice(0, 120)}` };
    return { result: 'fixed', newHead, applied: e.applied, pushed: true };
  } finally {
    if (wt) repo(['worktree', 'remove', '--force', wt]);
    if (dir) rmSync(dir, { recursive: true, force: true });
    release();
  }
}
