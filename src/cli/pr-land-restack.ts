/**
 * LAND-CONFLICT-AUTO-RESTACK R1 — 착지 전 충돌 측정·분류(읽기 전용).
 * `git merge-tree --write-tree -z` 를 일회용 객체 디렉터리에서 돌려(저장소 객체·ref·worktree 불변) 충돌 파일을 찾고,
 * 파일마다 base/main/PR 3-way 줄 단위 hunk 를 비교해 «텍스트(양쪽 유지 가능) / 의미(작성자) / 스택 squash» 로 가른다.
 * 구조 비교만 쓴다: hunk 범위의 base 줄 집합 교집합 · 선언 이름 중복(TypeScript AST) · 구문 오류. 사유 문자열 정규식 0.
 * 의미 충돌은 자동 해소 대상이 아니다 — 이 모듈은 어떤 경우에도 «조용히» 합치지 않고 분류와 근거(파일·hunk)를 돌려준다.
 */
import { spawnSync } from 'node:child_process';
import type { Command } from 'commander';
import { delimiter, extname, join, resolve } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import ts from 'typescript';
import { parseMergeTreeConflictPaths } from './pr-land-conflict-merge.js';
import { mergeTree } from '../git-smart/merge-tree.js';

export type RestackClass = 'clean' | 'text' | 'semantic' | 'stack-squash' | 'unmeasured';

/** 한 쪽이 base 에 가한 줄 단위 변경 — 반열린 구간 [start, end) (0-기준 줄 색인). 순수 삽입은 start === end. */
export interface LineHunk { readonly start: number; readonly end: number; readonly lines: readonly string[] }

export type HunkKind = 'adjacent' | 'same-point' | 'identical' | 'overlap' | 'inside-replaced';

export interface HunkReport {
  readonly kind: HunkKind;
  /** base 줄 번호(1-기준) 범위 [lo, hi]. 양쪽이 순수 삽입이면 `insertion` 이고 lo === hi === «그 줄 «뒤»» (0 = 첫 줄 앞). */
  readonly baseLines: readonly [number, number];
  readonly insertion: boolean;
  readonly main: readonly string[];
  readonly pr: readonly string[];
}

export interface FileReport {
  readonly path: string;
  readonly class: 'text' | 'semantic';
  readonly reasons: readonly string[];
  readonly hunks: readonly HunkReport[];
}

export interface RestackMeasurement {
  readonly verdict: RestackClass;
  readonly mainTip: string;
  readonly head: string;
  readonly files: readonly FileReport[];
  readonly stack?: { readonly carried: string; readonly ownCommits: readonly string[] };
  readonly reasons: readonly string[];
}

const SHA40 = /^[0-9a-f]{40}$/u;
const AUTO_EXTENSIONS: ReadonlySet<string> = new Set(['.ts', '.tsx', '.md', '.tsv', '.txt', '.sh', '.json']);
const EXCERPT_LINES = 3;
const EXCERPT_WIDTH = 100;

// ── git 실행 ───────────────────────────────────────────────────────────────

type GitResult = { status: number | null; stdout: string; stderr: string };
export type RestackGit = (args: readonly string[], cwd: string, env?: NodeJS.ProcessEnv, input?: string) => GitResult;

export const defaultRestackGit: RestackGit = (args, cwd, env, input) => {
  const result = spawnSync('git', [...args], { cwd, encoding: 'utf8', env: env ?? process.env, input, maxBuffer: 64 * 1024 * 1024 });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
};

// ── 줄 단위 3-way ──────────────────────────────────────────────────────────

/** base→other 의 줄 단위 변경. 비교는 `git diff --no-index -U0` 에 맡긴다(직접 LCS 를 짜지 않는다). */
export function lineHunks(base: string, other: string, git: RestackGit = defaultRestackGit): LineHunk[] | null {
  const dir = mkdtempSync(join(tmpdir(), 'restack-diff-'));
  try {
    const a = join(dir, 'a');
    const b = join(dir, 'b');
    writeFileSync(a, base);
    writeFileSync(b, other);
    const result = git(['diff', '--no-index', '--no-color', '--unified=0', '--no-ext-diff', a, b], dir);
    if (result.status !== 0 && result.status !== 1) return null;
    const hunks: LineHunk[] = [];
    const out = result.stdout.split('\n');
    for (let i = 0; i < out.length; i += 1) {
      const header = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/u.exec(out[i]!);
      if (!header) continue;
      const startLine = Number(header[1]);
      const count = header[2] === undefined ? 1 : Number(header[2]);
      const added: string[] = [];
      let j = i + 1;
      for (; j < out.length && !out[j]!.startsWith('@@ '); j += 1) {
        const line = out[j]!;
        if (line.startsWith('+')) added.push(line.slice(1));
      }
      // -U0: count===0 이면 startLine «뒤»에 삽입(=색인 startLine), 아니면 [startLine-1, startLine-1+count).
      const start = count === 0 ? startLine : startLine - 1;
      hunks.push({ start, end: start + count, lines: added });
      i = j - 1;
    }
    return hunks;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

function sameHunk(a: LineHunk, b: LineHunk): boolean {
  return a.start === b.start && a.end === b.end && a.lines.length === b.lines.length && a.lines.every((line, index) => line === b.lines[index]);
}

function relation(a: LineHunk, b: LineHunk): HunkKind {
  if (sameHunk(a, b)) return 'identical';
  const aIns = a.start === a.end;
  const bIns = b.start === b.end;
  if (aIns && bIns) return a.start === b.start ? 'same-point' : 'adjacent';
  if (aIns || bIns) {
    const [ins, rep] = aIns ? [a, b] : [b, a];
    return ins.start > rep.start && ins.start < rep.end ? 'inside-replaced' : 'adjacent';
  }
  return a.start < b.end && b.start < a.end ? 'overlap' : 'adjacent';
}

export interface Merge3Result {
  readonly merged: string | null;
  readonly pairs: ReadonlyArray<{ kind: HunkKind; main: LineHunk; pr: LineHunk }>;
  readonly blocked: boolean;
}

/** 양쪽 변경이 base 줄을 공유하지 않을 때만 합친다. 공유하면 blocked(의미). 인접·같은 지점 삽입·동일 변경은 합친다. */
export function merge3(baseLines: readonly string[], mainHunks: readonly LineHunk[], prHunks: readonly LineHunk[]): Merge3Result {
  const pairs: Array<{ kind: HunkKind; main: LineHunk; pr: LineHunk }> = [];
  let blocked = false;
  for (const m of mainHunks) {
    for (const p of prHunks) {
      // 서로 «가까운» 쌍만 보고한다 — 한 줄 이상 떨어진 쌍은 충돌 후보가 아니다.
      const near = m.start <= p.end + 1 && p.start <= m.end + 1;
      if (!near) continue;
      const kind = relation(m, p);
      pairs.push({ kind, main: m, pr: p });
      if (kind === 'overlap' || kind === 'inside-replaced') blocked = true;
    }
  }
  if (blocked) return { merged: null, pairs, blocked };
  // 동일 변경은 한 번만 적용. 같은 지점 삽입은 main 먼저, PR 나중.
  const all: Array<{ hunk: LineHunk; side: number }> = [];
  for (const m of mainHunks) all.push({ hunk: m, side: 0 });
  for (const p of prHunks) if (!mainHunks.some((m) => sameHunk(m, p))) all.push({ hunk: p, side: 1 });
  all.sort((x, y) => x.hunk.start - y.hunk.start || (x.hunk.end - x.hunk.start === 0 ? -1 : 1) - (y.hunk.end - y.hunk.start === 0 ? -1 : 1) || x.side - y.side);
  const out: string[] = [];
  let cursor = 0;
  for (const { hunk } of all) {
    if (hunk.start < cursor) return { merged: null, pairs, blocked: true };
    out.push(...baseLines.slice(cursor, hunk.start), ...hunk.lines);
    cursor = hunk.end;
  }
  out.push(...baseLines.slice(cursor));
  return { merged: out.join('\n'), pairs, blocked: false };
}

// ── 의미 검사(합친 결과) ────────────────────────────────────────────────────

function bindingNames(name: ts.BindingName, add: (identifier: ts.Identifier) => void): void {
  if (ts.isIdentifier(name)) { add(name); return; }
  for (const element of name.elements) if (ts.isBindingElement(element)) bindingNames(element.name, add);
}

function declaredNames(text: string, path: string): { names: string[]; syntaxErrors: number } {
  const kind = path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
  const syntaxErrors = (sf as unknown as { parseDiagnostics?: readonly unknown[] }).parseDiagnostics?.length ?? 0;
  const names: string[] = [];
  const add = (identifier: ts.Identifier | undefined): void => { if (identifier) names.push(identifier.text); };
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st)) { if (st.body) add(st.name); }
    else if (ts.isClassDeclaration(st) || ts.isEnumDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isInterfaceDeclaration(st)) add(st.name);
    else if (ts.isModuleDeclaration(st) && ts.isIdentifier(st.name)) add(st.name);
    else if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) bindingNames(d.name, add);
    else if (ts.isImportDeclaration(st) && st.importClause) {
      add(st.importClause.name);
      const nb = st.importClause.namedBindings;
      if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) add(el.name);
      else if (nb && ts.isNamespaceImport(nb)) add(nb.name);
    }
  }
  return { names, syntaxErrors };
}

function duplicates(names: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const name of names) { if (seen.has(name)) dup.add(name); seen.add(name); }
  return dup;
}

function checkMergedMeaning(path: string, base: string, merged: string): string[] {
  const ext = extname(path);
  const problems: string[] = [];
  if (ext === '.ts' || ext === '.tsx') {
    const before = declaredNames(base, path);
    const after = declaredNames(merged, path);
    // 구문 오류는 «개수 비교»가 아니라 합친 결과에 하나라도 있으면 의미 — 기존 오류가 사라지고 새 오류가 생기는 경우도 잡는다.
    if (after.syntaxErrors > 0) problems.push('merged-syntax-error');
    const baseDup = duplicates(before.names);
    const newDup = [...duplicates(after.names)].filter((name) => !baseDup.has(name));
    if (newDup.length > 0) problems.push(`duplicate-definition:${newDup.sort().join(',')}`);
  } else if (ext === '.json') {
    try { JSON.parse(base); } catch { return problems; }
    try { JSON.parse(merged); } catch { problems.push('merged-json-invalid'); }
  }
  return problems;
}

function excerpt(lines: readonly string[]): string[] {
  return lines.slice(0, EXCERPT_LINES).map((line) => line.slice(0, EXCERPT_WIDTH));
}

/** 충돌 파일 하나를 분류한다. base/main/pr 본문은 호출자가 읽어 온다(null = 그 쪽에 파일 없음). 합친 결과는 판정에만 쓰고 돌려주지 않는다. */
export function classifyConflictFile(path: string, base: string | null, main: string | null, pr: string | null, git: RestackGit = defaultRestackGit): FileReport {
  const semantic = (reasons: string[], hunks: HunkReport[] = []): FileReport => ({ path, class: 'semantic', reasons, hunks });
  if (base === null || main === null || pr === null) return semantic(['add-delete-or-rename']);
  if ([base, main, pr].some((text) => text.includes('\0'))) return semantic(['binary']);
  if (!AUTO_EXTENSIONS.has(extname(path))) return semantic([`unsupported-extension:${extname(path) || 'none'}`]);
  if ([base, main, pr].some((text) => text.length > 0 && !text.endsWith('\n'))) return semantic(['no-trailing-newline']);
  const mainHunks = lineHunks(base, main, git);
  const prHunks = lineHunks(base, pr, git);
  if (mainHunks === null || prHunks === null) return semantic(['diff-unmeasured']);
  // 끝 줄바꿈 때문에 생기는 마지막 빈 요소를 맞춘다(모든 본문이 \n 으로 끝남을 위에서 확인).
  const baseLines = base.split('\n');
  const result = merge3(baseLines, mainHunks, prHunks);
  const hunks: HunkReport[] = result.pairs.map(({ kind, main: m, pr: p }) => {
    const insertion = m.start === m.end && p.start === p.end;
    // 삽입은 «그 줄 뒤» 번호(start) 하나, 그 밖의 변경은 1-기준 [첫 줄, 끝 줄]. 삽입과 수정이 섞이면 둘을 아우른다.
    const lo = Math.min(m.start === m.end ? m.start : m.start + 1, p.start === p.end ? p.start : p.start + 1);
    const hi = Math.max(m.start === m.end ? m.start : m.end, p.start === p.end ? p.start : p.end);
    return { kind, baseLines: [lo, hi] as const, insertion, main: excerpt(m.lines), pr: excerpt(p.lines) };
  });
  if (result.blocked || result.merged === null) return semantic(['shared-base-lines'], hunks);
  const problems = checkMergedMeaning(path, base, result.merged);
  if (problems.length > 0) return semantic(problems, hunks);
  return { path, class: 'text', reasons: hunks.length === 0 ? ['no-line-conflict'] : [...new Set(hunks.map((h) => h.kind))].sort(), hunks };
}

// ── merge-tree 측정 ────────────────────────────────────────────────────────

export interface MeasureRestackInput {
  readonly cwd: string;
  /** 착지 대상 main 끝(40자 sha). */
  readonly mainTip: string;
  /** 측정할 PR head(40자 sha). */
  readonly head: string;
  /** PR 이 쌓여 있던 아래 PR 의 head(40자 sha) — 있으면 스택 squash 를 판정한다. */
  readonly stackBase?: string;
  readonly git?: RestackGit;
}

export function measureRestack(input: MeasureRestackInput): RestackMeasurement {
  const git = input.git ?? defaultRestackGit;
  const { cwd, mainTip, head, stackBase } = input;
  const unmeasured = (reason: string): RestackMeasurement => ({ verdict: 'unmeasured', mainTip, head, files: [], reasons: [reason] });
  if (!SHA40.test(mainTip) || !SHA40.test(head) || (stackBase !== undefined && !SHA40.test(stackBase))) return unmeasured('sha-not-40-hex');

  // 스택 squash: 아래 PR 의 옛 head 를 조상으로 싣고 있는데 main 은 그 커밋을 모른다(squash 로 새 커밋이 됐다).
  let stack: RestackMeasurement['stack'];
  if (stackBase !== undefined) {
    const carries = git(['merge-base', '--is-ancestor', stackBase, head], cwd);
    const inMain = git(['merge-base', '--is-ancestor', stackBase, mainTip], cwd);
    if (carries.status !== 0 && carries.status !== 1) return unmeasured('stack-ancestry-unmeasured');
    if (inMain.status !== 0 && inMain.status !== 1) return unmeasured('stack-ancestry-unmeasured');
    if (carries.status === 0 && inMain.status === 1) {
      const own = git(['rev-list', '--reverse', `${stackBase}..${head}`], cwd);
      if (own.status !== 0) return unmeasured('stack-own-commits-unmeasured');
      stack = { carried: stackBase, ownCommits: own.stdout.split('\n').filter(Boolean) };
    }
  }

  const objects = git(['rev-parse', '--git-path', 'objects'], cwd);
  if (objects.status !== 0 || !objects.stdout.trim()) return unmeasured('object-directory-unmeasured');
  let temporary: string;
  try { temporary = mkdtempSync(join(tmpdir(), 'elanous-restack-')); } catch { return unmeasured('temporary-object-directory-unmeasured'); }
  const env = {
    ...process.env,
    GIT_OBJECT_DIRECTORY: temporary,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: [resolve(cwd, objects.stdout.trim()), process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES].filter(Boolean).join(delimiter),
  };
  try {
    const merged = mergeTree(args => git(args, cwd, env), mainTip, head, [], ['-z']);
    if (merged.status === 0) return { verdict: stack ? 'stack-squash' : 'clean', mainTip, head, files: [], ...(stack ? { stack } : {}), reasons: stack ? ['stack-carries-squashed-base'] : [] };
    const parsed = parseMergeTreeConflictPaths(merged.stdout, merged.status);
    if (!parsed.measured) return unmeasured('merge-tree-unmeasured');
    const base = git(['merge-base', mainTip, head], cwd);
    if (base.status !== 0 || !SHA40.test(base.stdout.trim())) return unmeasured('merge-base-unmeasured');
    const baseSha = base.stdout.trim();
    // 부재(경로 없음)와 읽기 실패(객체 손상 등)를 구분한다: ls-tree 가 성공했는데 출력이 비면 «없음», 실패면 «읽기 실패».
    const show = (rev: string, path: string): string | null | undefined => {
      const listed = git(['ls-tree', rev, '--', path], cwd, env);
      if (listed.status !== 0) return undefined;
      const entry = /^(\d+) (\w+) ([0-9a-f]{40,64})\t/u.exec(listed.stdout);
      if (listed.stdout.trim() === '') return null;
      if (!entry || entry[2] !== 'blob' || entry[1] === '120000') return `\0non-regular:${entry?.[1] ?? '?'}`; // 심볼릭 링크·서브모듈 → 바이너리 취급(의미)
      const shown = git(['cat-file', 'blob', entry[3]!], cwd, env);
      return shown.status === 0 ? shown.stdout : undefined;
    };
    const files: FileReport[] = [];
    for (const path of parsed.paths) {
      const b = show(baseSha, path);
      const m = show(mainTip, path);
      const p = show(head, path);
      if (b === undefined || m === undefined || p === undefined) return unmeasured(`blob-unreadable:${path}`);
      files.push(classifyConflictFile(path, b, m, p, git));
    }
    const verdict: RestackClass = stack ? 'stack-squash' : files.some((f) => f.class === 'semantic') ? 'semantic' : 'text';
    return { verdict, mainTip, head, files, ...(stack ? { stack } : {}), reasons: stack ? ['stack-carries-squashed-base'] : [] };
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

/** `restack-plan` 종료 코드 — 0 충돌 없음 · 3 텍스트(자동 가능) · 4 의미(작성자) · 5 스택 squash · 6 측정 불가. */
export function restackExitCode(verdict: RestackClass): number {
  switch (verdict) {
    case 'clean': return 0;
    case 'text': return 3;
    case 'semantic': return 4;
    case 'stack-squash': return 5;
    default: return 6;
  }
}

export function renderRestackMeasurement(result: RestackMeasurement): string {
  const lines = [`restack ${result.verdict} · main ${result.mainTip.slice(0, 12)} · head ${result.head.slice(0, 12)}`];
  if (result.stack) {
    lines.push(`  스택 squash: 아래 PR head ${result.stack.carried.slice(0, 12)} 를 싣고 있음 · 자기 커밋 ${result.stack.ownCommits.length}개 (cherry-pick ${result.stack.carried.slice(0, 12)}..${result.head.slice(0, 12)})`);
    for (const sha of result.stack.ownCommits) lines.push(`    ${sha.slice(0, 12)}`);
  }
  for (const reason of result.reasons) if (!result.stack) lines.push(`  사유: ${reason}`);
  for (const file of result.files) {
    lines.push(`  ${file.class === 'text' ? '텍스트' : '의미'} ${file.path} — ${file.reasons.join(', ')}`);
    for (const hunk of file.hunks) {
      lines.push(`    hunk ${hunk.kind} ${hunk.insertion ? `base ${hunk.baseLines[0]} 줄 뒤 삽입` : `base ${hunk.baseLines[0]}-${hunk.baseLines[1]}`}`);
      for (const line of hunk.main) lines.push(`      main| ${line}`);
      for (const line of hunk.pr) lines.push(`      PR  | ${line}`);
    }
  }
  return lines.join('\n');
}

export interface RestackPlanCommandDeps {
  readonly out: { log: (message: string) => void };
  readonly setExitCode: (code: number) => void;
}

/** `eln pr restack-plan` 등록 — pr-cli.ts 는 이 함수를 한 줄로 부른다(다른 열린 PR 과 pr-cli.ts 겹침 최소). */
export function registerRestackPlanCommand(pr: Command, deps: RestackPlanCommandDeps): void {
  pr.command('restack-plan')
    .description('착지 전 충돌 측정·분류(읽기 전용) — exit 0 충돌 없음 · 3 텍스트(양쪽 유지 가능) · 4 의미(작성자) · 5 스택 squash · 6 측정 불가')
    .requiredOption('--head <rev>', '측정할 PR head(커밋 sha 또는 ref)')
    .option('--main <rev>', '착지 대상 main 끝', 'origin/main')
    .option('--stack-base <rev>', 'PR 이 쌓여 있던 아래 PR 의 옛 head — 주면 스택 squash 를 판정한다')
    .option('--cwd <path>', '저장소 경로')
    .option('--json', '구조화 출력')
    .action((opts: { head: string; main: string; stackBase?: string; cwd?: string; json?: boolean }) => {
      const cwd = opts.cwd ?? process.cwd();
      const resolveRev = (rev: string): string => {
        const result = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], { cwd, encoding: 'utf8' });
        return result.status === 0 ? result.stdout.trim() : rev;
      };
      const measured = measureRestack({ cwd, mainTip: resolveRev(opts.main), head: resolveRev(opts.head),
        ...(opts.stackBase ? { stackBase: resolveRev(opts.stackBase) } : {}) });
      deps.out.log(opts.json ? JSON.stringify(measured) : renderRestackMeasurement(measured));
      const code = restackExitCode(measured.verdict);
      if (code !== 0) deps.setExitCode(code);
    });
}
