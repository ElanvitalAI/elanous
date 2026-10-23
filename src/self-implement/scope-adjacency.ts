// SCOPE-HELD-DELIVER (0.2.25) — which out-of-scope edits sit right next to a declared target.
// 10-11~12: 34 scope-held runs auto-answered «Stay in scope» after 30 unanswered minutes and threw away finished work;
// the outside files were a declared file's same-folder neighbours (its other tests, a sibling helper, the folder's
// plugin.json). Those are adjacent: the run goes on to its gate instead of parking on a question nobody answers.

const normalize = (path: string): string => path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
const dirOf = (path: string): string => { const at = path.lastIndexOf('/'); return at < 0 ? '' : path.slice(0, at); };

/** Split out-of-scope files into those adjacent to a declared target and the rest. A file is adjacent when it sits in
 *  the same folder as a declared file. A declared folder adds nothing (its contents are already in scope), and a
 *  declared repo-root file adds nothing (the root holds the whole repo's config). */
export function classifyOutOfScope(outsideFiles: readonly string[], declaredPaths: readonly string[]): { adjacent: string[]; other: string[] } {
  const folders = new Set<string>();
  for (const declared of declaredPaths.map(normalize)) {
    const dir = dirOf(declared);
    // A path with an extension names a file; without one it names a folder.
    if (dir && /\.[A-Za-z0-9]+$/.test(declared.slice(dir.length + 1))) folders.add(dir);
  }
  const adjacent: string[] = [];
  const other: string[] = [];
  for (const file of outsideFiles) (folders.has(dirOf(normalize(file))) ? adjacent : other).push(file);
  return { adjacent, other };
}

// SCOPE-AS-DIRECTION (0.2.35 · 대표 10-21 «골은 방향·원칙·KPI 를 정하고 구현은 적응한다 — 파일 단위 마이크로 관리는 틀렸다»).
// 10-20: 13 runs held with PR 0; half of the crossed files were necessary wiring (CLI registration, production callers,
// ledger files). Target paths are now the starting point: outside edits are accepted, named with a kind, and handed to
// the reviewer in the PR body. Only a deletion, a protected path, or an outside count over the cap stops the run.

export type ScopeExpansionKind = 'neighbour' | 'caller-or-registration' | 'paired-test' | 'other';
export interface ScopeExpansionFile { path: string; kind: ScopeExpansionKind }
export interface ScopeExpansion { files: ScopeExpansionFile[]; count: number }
/** Every stop reason, in report order — the one source; the Pod parent (self-implement.ts) reads held results against it. */
export const SCOPE_STOP_REASONS = ['deletion', 'protected-path', 'over-cap', 'name-cap'] as const;
export type ScopeStopReason = (typeof SCOPE_STOP_REASONS)[number];

/** Accepted outside files above this count stop the run: past it the change is no longer «the goal, adapted». */
export const SCOPE_EXPANSION_CAP = 10;

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const CODE_EXT = /\.(?:[cm]?[jt]sx?)$/;
const baseOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
const stemOf = (path: string): string => baseOf(path).replace(TEST_FILE, '').replace(/\.[^.]+$/, '');
const withoutCodeExt = (path: string): string => path.replace(CODE_EXT, '');

/** Paths an unattended run never edits on its own: rules, anything credential-like, production elanous config. */
export function isProtectedScopePath(path: string): boolean {
  const p = normalize(path);
  if (p === '.rules' || p.startsWith('.rules/')) return true;
  if (/credential|secret/i.test(p)) return true;
  const base = baseOf(p);
  if (base === 'auth.json' || base === '.env' || base.startsWith('.env.')) return true;
  return /(^|\/)\.elanous[^/]*\/(.*\/)?config\.json$/.test(p);
}

function resolveRelative(fromFile: string, spec: string): string {
  const parts = dirOf(fromFile) ? dirOf(fromFile).split('/') : [];
  for (const seg of spec.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') parts.pop(); else parts.push(seg);
  }
  return parts.join('/');
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Name each outside file's relation to the declared targets. Deterministic: path shape and plain text only.
 *  Order of kinds: paired-test → neighbour (same folder as a declared file) → caller-or-registration (index.ts,
 *  *-cli.ts, imports a declared file, or names an exported symbol of one) → other. `readFile` is relative to the tree. */
export function classifyScopeExpansion(
  outsideFiles: readonly string[], declaredPaths: readonly string[], readFile: (path: string) => string | undefined = () => undefined,
): ScopeExpansionFile[] {
  const declared = declaredPaths.map(normalize);
  const adjacentSet = new Set(classifyOutOfScope(outsideFiles, declaredPaths).adjacent);
  const declaredFiles = declared.filter(path => /\.[A-Za-z0-9]+$/.test(baseOf(path)));
  const declaredModules = new Set(declaredFiles.filter(path => CODE_EXT.test(path)).map(withoutCodeExt));
  const pairStems = new Set([...declaredFiles, ...outsideFiles.map(normalize).filter(path => !TEST_FILE.test(path))].map(stemOf));
  const exportedNames: string[] = [];
  for (const file of declaredFiles) {
    let text: string | undefined;
    try { text = readFile(file); } catch { text = undefined; }
    if (!text) continue;
    for (const match of text.matchAll(/export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g)) {
      if (match[1]!.length >= 4 && !exportedNames.includes(match[1]!)) exportedNames.push(match[1]!);
    }
  }
  const namePatterns = exportedNames.map(name => new RegExp(`(^|[^\\w$])${escapeRegExp(name)}([^\\w$]|$)`));
  const callsDeclared = (file: string): boolean => {
    let text: string | undefined;
    try { text = readFile(file); } catch { text = undefined; }
    if (!text) return false;
    for (const match of text.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)['"]([^'"]+)['"]/g)) {
      const spec = match[1]!;
      if (spec.startsWith('.') && declaredModules.has(withoutCodeExt(resolveRelative(file, spec)))) return true;
    }
    return namePatterns.some(pattern => pattern.test(text!));
  };
  return outsideFiles.map(path => {
    const p = normalize(path);
    const base = baseOf(p);
    const kind: ScopeExpansionKind = TEST_FILE.test(p) && pairStems.has(stemOf(p)) ? 'paired-test'
      : adjacentSet.has(path) ? 'neighbour'
      : /^index\.[cm]?[jt]sx?$/.test(base) || /-cli\.[cm]?[jt]sx?$/.test(base) || callsDeclared(p) ? 'caller-or-registration'
      : 'other';
    return { path, kind };
  });
}

export type ScopeExpansionDecision =
  | { accept: true; expansion: ScopeExpansion }
  | { accept: false; reasons: ScopeStopReason[]; deleted: string[]; protectedPaths: string[]; expansion: ScopeExpansion };

/** Accept outside edits by default; stop only on a deletion, a protected path, a count over the cap, or an
 *  incomplete name list (the guard cannot judge files it did not see). */
export function decideScopeExpansion(input: {
  outsideFiles: readonly string[]; declaredPaths: readonly string[]; deleted: readonly string[]; nameCapReached: boolean;
  cap?: number; readFile?: (path: string) => string | undefined;
}): ScopeExpansionDecision {
  const files = classifyScopeExpansion(input.outsideFiles, input.declaredPaths, input.readFile);
  const expansion: ScopeExpansion = { files, count: files.length };
  const protectedPaths = input.outsideFiles.filter(isProtectedScopePath);
  const reasons: ScopeStopReason[] = [];
  if (input.deleted.length) reasons.push('deletion');
  if (protectedPaths.length) reasons.push('protected-path');
  if (files.length > (input.cap ?? SCOPE_EXPANSION_CAP)) reasons.push('over-cap');
  if (input.nameCapReached) reasons.push('name-cap');
  return reasons.length ? { accept: false, reasons, deleted: [...input.deleted], protectedPaths, expansion } : { accept: true, expansion };
}

/** PR body section for the reviewer: each accepted outside file with its kind, judged against the goal's direction. */
export function renderScopeExpansionSection(expansion: ScopeExpansion | undefined): string {
  if (!expansion || expansion.files.length === 0) return '';
  return [
    '', '', `## 범위 확장 (${expansion.count})`,
    '대상 경로는 출발점이다 — 아래 파일은 대상 밖에서 바뀌었고 자동으로 받아들였다. 골의 방향·원칙·KPI 에 비춰 판단해 달라.',
    ...expansion.files.map(file => `- \`${file.path}\` — ${file.kind}`),
  ].join('\n');
}
