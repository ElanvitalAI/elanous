// 시험 간섭 꼴 정적 래칫 (TEST-INTERFERENCE-RATCHET · 0.2.31 · 대표 승인)
//
// 왜 있나: 0.2.30 게이트가 «측정 불가»로 네 번 멈췄다. 넷 다 제품 결함이 아니라 «시험이 다음 시험을
// 건드린» 간섭이었다. bun 은 시간초과된 시험의 약속을 «취소하지 않는다» — 본문은 afterEach 뒤에도 계속
// 돌며 전역(env · cwd · window · 잠금)을 다음 시험 위에서 만진다. 표본(수리 PR):
//   A nexus     #28517 e56d8c28 — 시험 본문 안 `await import('../src/nexus/index.js')` 가 차가운 Pod 에서
//               5s 를 넘겨, 남은 runNexus 가 다음 시험 폴더의 잠금을 잡았다(TelegramLockError).
//   B probe     #28527 b5ca5041 — 본문 안 무거운 import 로 시간초과 → afterEach 가 폴더를 지운 «뒤에»
//               본문이 그 폴더로 chdir(ENOENT). 복원은 본문 finally 뿐(시간초과면 afterEach 보다 늦다).
//   E integrity #28527 — 자식 bun 에 100ms 한도 → 차가운 Pod 에서 처리기 걸기 전에 SIGTERM.
//   D PWA       #28527 — react-test-renderer 맨몸 unmount 가 passive 정리를 afterAll(window 걷기) 뒤로 미뤄
//               다음 파일에서 «window is not defined».
// 꼴 C(afterEach 없이 env 바꿈)는 칸 문면의 넷째 꼴이다 — 표본 넷 중 직접 짝은 없다(nexus 는 afterEach 가 있었다).
//
// 판정은 «보수적»이다: 꼴마다 «정리 짝»이 보이면 통과시킨다. 기존 위반은 허용 목록(파일·꼴·개수)으로
// 시작하고, 개수가 «늘면»만 실패한다(래칫). 줄면 갱신 안내만 낸다.
//
// 쓰는 법:
//   bun scripts/ratchets/test-interference-patterns.ts                 # 전수 판정(새 위반이면 exit 1)
//   bun scripts/ratchets/test-interference-patterns.ts <file…>         # 그 파일만 판정(착지 범위용)
//   bun scripts/ratchets/test-interference-patterns.ts --update-allowlist   # 허용 목록을 지금 전수로 다시 쓴다

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import * as ts from 'typescript';

export const REPO_ROOT = resolve(import.meta.dir, '../..');
export const ALLOWLIST_PATH = join(REPO_ROOT, 'scripts/ratchets/test-interference-patterns.allowlist.txt');
export const UPDATE_COMMAND = 'bun scripts/ratchets/test-interference-patterns.ts --update-allowlist';

export type InterferenceForm =
  | 'body-dynamic-import'
  | 'chdir-without-restore'
  | 'env-without-restore'
  | 'bare-unmount-with-window'
  | 'short-child-timeout';

export const FORMS: Record<InterferenceForm, string> = {
  'body-dynamic-import': '시험 본문 안 저장소 모듈 동적 import — 차가운 Pod 에서 5s 를 넘기고 남은 본문이 다음 시험 위에서 돈다. 처방: beforeAll(넉넉한 한도)로 데우기 또는 정적 import (test/helpers/nexus-boot-guard.ts 꼴)',
  'chdir-without-restore': 'process.chdir 에 정리 짝이 없다 — afterEach/afterAll 의 cwd 복원 또는 «동기» 함수의 finally 복원. 비동기 본문의 finally 는 시간초과면 afterEach 보다 늦다(test/helpers/inflight-test-guard.ts 꼴)',
  'env-without-restore': 'process.env 를 바꾸는데 afterEach/afterAll 또는 finally 복원이 없다 — 다음 시험이 바뀐 env 위에서 돈다',
  'bare-unmount-with-window': 'react-test-renderer 맨몸 unmount() — passive 정리를 afterAll(window 걷기) 뒤로 미뤄 «window is not defined». 처방: await act(async () => renderer.unmount())',
  'short-child-timeout': '자식 프로세스(process.execPath)에 1000ms 미만 한도 — 차가운 Pod 에서 기동 전에 죽는다. 처방: 기동 여유를 둔 한도',
};

export interface Violation { file: string; line: number; form: InterferenceForm; text: string }

const TEST_FILE = /\.test\.tsx?$/;
const SKIP_DIRS = new Set(['node_modules']); // ⚠️ 'build'·'out' 은 소스 폴더 이름이기도 하다(src/autopilot/build) — 빼지 않는다
/** 내용 사전 거름 — 이 낱말이 하나도 없으면 파싱하지 않는다(전수 스캔 시간). */
const PREFILTER = /import\(|chdir|process\.env|unmount|execPath/;

export function listTestFiles(root = REPO_ROOT): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      if (name.startsWith('.') || SKIP_DIRS.has(name)) continue;
      const full = join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) walk(full);
      else if (TEST_FILE.test(name)) out.push(relative(root, full).split(sep).join('/'));
    }
  };
  walk(root);
  return out.sort();
}

type Role = 'test' | 'before' | 'after' | 'helper' | 'top';
const HOOKS: Record<string, Role> = { beforeAll: 'before', beforeEach: 'before', afterAll: 'after', afterEach: 'after' };

function baseIdentifier(expr: ts.Expression): string | undefined {
  let e: ts.Expression = expr;
  for (;;) {
    if (ts.isIdentifier(e)) return e.text;
    if (ts.isPropertyAccessExpression(e)) e = e.expression;
    else if (ts.isCallExpression(e)) e = e.expression;
    else return undefined;
  }
}

function isFunctionLike(node: ts.Node): node is ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration | ts.MethodDeclaration {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node);
}

/** `import { afterEach as freezeIsolationAfterEach } from 'bun:test'` — local name → bun:test name. */
type Aliases = Map<string, string>;
let aliases: Aliases = new Map();

function readAliases(sf: ts.SourceFile): Aliases {
  const map: Aliases = new Map();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || st.moduleSpecifier.text !== 'bun:test') continue;
    const named = st.importClause?.namedBindings;
    if (named && ts.isNamedImports(named)) for (const el of named.elements) map.set(el.name.text, (el.propertyName ?? el.name).text);
  }
  return map;
}

function bunName(expr: ts.Expression): string | undefined {
  const base = baseIdentifier(expr);
  return base === undefined ? undefined : aliases.get(base) ?? base;
}

/** The role a function plays when it is (or is wrapped as) an argument of test()/it()/hook calls. */
function callbackRole(fn: ts.Node): Role | undefined {
  let child: ts.Node = fn;
  let parent = fn.parent;
  // `guard.track(async () => …)` — the callback may sit one call deep.
  for (let depth = 0; depth < 2 && parent && ts.isCallExpression(parent); depth++) {
    if (!parent.arguments.includes(child as ts.Expression)) return undefined;
    const base = bunName(parent.expression);
    if (base === 'test' || base === 'it') return 'test';
    if (base && HOOKS[base]) return HOOKS[base];
    child = parent;
    parent = parent.parent;
  }
  return undefined;
}

interface Ctx { role: Role; fns: ts.Node[] /* enclosing functions, nearest first */ }

function context(node: ts.Node): Ctx {
  const fns: ts.Node[] = [];
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    if (isFunctionLike(p)) {
      fns.push(p);
      const role = callbackRole(p);
      if (role) return { role, fns };
    }
  }
  return { role: fns.length ? 'helper' : 'top', fns };
}

/** A function whose own name says it restores (`const restore = () => …` · `function resetEnv()`) — its writes are the pair. */
function isRestoreHelper(fn: ts.Node): boolean {
  let name: string | undefined;
  if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && fn.name) name = fn.name.getText();
  else if (fn.parent && ts.isVariableDeclaration(fn.parent)) name = fn.parent.name.getText();
  else if (fn.parent && ts.isPropertyAssignment(fn.parent)) name = fn.parent.name.getText();
  return !!name && /restore|reset|cleanup|teardown|dispose/i.test(name);
}

function inFinally(node: ts.Node): boolean {
  for (let p: ts.Node | undefined = node; p && p.parent; p = p.parent) {
    if (isFunctionLike(p)) return false;
    if (ts.isTryStatement(p.parent) && p.parent.finallyBlock === p) return true;
  }
  return false;
}

function isAsyncFn(fn: ts.Node): boolean {
  const mods = ts.canHaveModifiers(fn) ? ts.getModifiers(fn) : undefined;
  return !!mods?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
}

function finallyTexts(fn: ts.Node, sf: ts.SourceFile): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (n !== fn && isFunctionLike(n)) return;
    if (ts.isTryStatement(n) && n.finallyBlock) out.push(n.finallyBlock.getText(sf));
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(fn, visit);
  return out;
}

function isProcessMember(expr: ts.Expression, member: string): boolean {
  return ts.isPropertyAccessExpression(expr) && expr.name.text === member && ts.isIdentifier(expr.expression) && expr.expression.text === 'process';
}

function isProcessEnvAccess(expr: ts.Expression): boolean {
  if (ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr)) return isProcessMember(expr.expression, 'env');
  return false;
}

function normalizeSpecifier(spec: string): string {
  return spec.replace(/\.(m?[jt]sx?)$/, '');
}

export function scanSource(text: string, file: string): Violation[] {
  if (!PREFILTER.test(text)) return [];
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  aliases = readAliases(sf);
  const out: Violation[] = [];
  const add = (node: ts.Node, form: InterferenceForm) => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    out.push({ file, line, form, text: node.getText(sf).split('\n')[0]!.slice(0, 120) });
  };

  // File-level facts.
  const staticImports = new Set<string>();
  const warmedImports = new Set<string>();
  const afterHookTexts: string[] = [];
  const topFunctions = new Map<string, ts.Node>();
  let usesRenderer = false;
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      const spec = st.moduleSpecifier.text;
      if (spec === 'react-test-renderer' || spec.startsWith('@testing-library/')) usesRenderer = true;
      if (!st.importClause?.isTypeOnly) staticImports.add(normalizeSpecifier(spec));
    }
    if (ts.isFunctionDeclaration(st) && st.name) topFunctions.set(st.name.text, st);
  }
  const collect = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const base = ts.isIdentifier(n.expression) ? aliases.get(n.expression.text) ?? n.expression.text : undefined;
      if (base && HOOKS[base] === 'after') {
        for (const arg of n.arguments) {
          afterHookTexts.push(arg.getText(sf));
          if (ts.isIdentifier(arg) && topFunctions.has(arg.text)) afterHookTexts.push(topFunctions.get(arg.text)!.getText(sf));
        }
      }
      if (n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0])) {
        const role = context(n).role;
        if (role === 'before' || role === 'top') warmedImports.add(normalizeSpecifier(n.arguments[0].text));
      }
    }
    ts.forEachChild(n, collect);
  };
  collect(sf);
  const afterHooks = afterHookTexts.join('\n');
  const mentionsWindow = /\bwindow\b/.test(text);

  const insideAct = (node: ts.Node): boolean => {
    for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
      if (ts.isCallExpression(p) && bunName(p.expression) === 'act') return true;
    }
    return false;
  };

  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      // A — dynamic import of a repository module inside a test body.
      if (n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0])) {
        const spec = n.arguments[0].text;
        const norm = normalizeSpecifier(spec);
        const ctx = context(n);
        // `mock.module(…)` then import is the bun idiom for a freshly mocked module — not this form.
        const mocks = ctx.fns.some((fn) => /\bmock\.module\s*\(/.test(fn.getText(sf)));
        if (spec.startsWith('.') && ctx.role === 'test' && !mocks && !staticImports.has(norm) && !warmedImports.has(norm)) add(n, 'body-dynamic-import');
      }
      // B — process.chdir without a restore pair.
      if (isProcessMember(n.expression, 'chdir')) {
        const ctx = context(n);
        if (ctx.role !== 'after' && !inFinally(n) && !ctx.fns.some(isRestoreHelper) && !/process\.chdir\s*\(/.test(afterHooks)) {
          const paired = ctx.fns.some((fn) => !isAsyncFn(fn) && finallyTexts(fn, sf).some((t) => /process\.chdir\s*\(/.test(t)));
          if (!paired) add(n, 'chdir-without-restore');
        }
      }
      // E — a child bun/node process with a sub-second timeout.
      if (n.arguments.some((a) => isProcessMember(a as ts.Expression, 'execPath'))) {
        const literalArgs = n.arguments.filter(ts.isNumericLiteral);
        const optionTimeouts = n.arguments.filter(ts.isObjectLiteralExpression).flatMap((o) => o.properties
          .filter((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && /^(timeout|timeoutMs)$/.test(p.name.getText(sf)) && ts.isNumericLiteral(p.initializer))
          .map((p) => p.initializer as ts.NumericLiteral));
        if ([...literalArgs, ...optionTimeouts].some((lit) => { const v = Number(lit.text.replace(/_/g, '')); return v > 0 && v < 1000; })) add(n, 'short-child-timeout');
      }
      // D — bare react-test-renderer unmount in a file that stubs window.
      if (usesRenderer && mentionsWindow && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'unmount'
        && n.arguments.length === 0 && !insideAct(n)) add(n, 'bare-unmount-with-window');
    }
    // C — process.env mutation without a restore pair.
    let envMutation = false;
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      envMutation = isProcessEnvAccess(n.left) || isProcessMember(n.left, 'env');
    } else if (ts.isDeleteExpression(n)) {
      envMutation = isProcessEnvAccess(n.expression);
    } else if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'assign'
      && ts.isIdentifier(n.expression.expression) && n.expression.expression.text === 'Object' && n.arguments[0] && isProcessMember(n.arguments[0], 'env')) {
      envMutation = true;
    }
    if (envMutation) {
      const ctx = context(n);
      if (ctx.role !== 'after' && !inFinally(n) && !ctx.fns.some(isRestoreHelper) && !/process\.env|restore|[Ee]nv/.test(afterHooks)) {
        const paired = ctx.fns.some((fn) => finallyTexts(fn, sf).some((t) => /process\.env|restore|[Ee]nv/.test(t)));
        if (!paired) add(n, 'env-without-restore');
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

export function scanFiles(files: readonly string[], root = REPO_ROOT): Violation[] {
  const out: Violation[] = [];
  for (const file of files) {
    let text: string;
    try { text = readFileSync(join(root, file), 'utf8'); } catch { continue; }
    out.push(...scanSource(text, file));
  }
  return out;
}

export type Allowlist = Map<string, number>; // `${form}\t${file}` → count

export const allowKey = (form: InterferenceForm, file: string) => `${form}\t${file}`;

export function parseAllowlist(text: string): Allowlist {
  const map: Allowlist = new Map();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [form, file, count] = line.split('\t');
    if (!form || !file) continue;
    map.set(`${form}\t${file}`, Number(count ?? '1') || 1);
  }
  return map;
}

export function countByKey(violations: readonly Violation[]): Allowlist {
  const map: Allowlist = new Map();
  for (const v of violations) map.set(allowKey(v.form, v.file), (map.get(allowKey(v.form, v.file)) ?? 0) + 1);
  return map;
}

export interface RatchetResult {
  /** Violations in a file·form whose count exceeds the allowlist (all of that file·form's lines are listed). */
  fresh: Violation[];
  /** Allowlist entries that are now smaller than allowed (or gone) — the list can be tightened. */
  stale: { key: string; allowed: number; now: number }[];
}

export function judge(violations: readonly Violation[], allow: Allowlist, scope?: ReadonlySet<string>): RatchetResult {
  const now = countByKey(violations);
  const fresh = violations.filter((v) => (now.get(allowKey(v.form, v.file)) ?? 0) > (allow.get(allowKey(v.form, v.file)) ?? 0));
  const stale = [...allow].filter(([key]) => !scope || scope.has(key.split('\t')[1]!))
    .filter(([key, allowed]) => (now.get(key) ?? 0) < allowed).map(([key, allowed]) => ({ key, allowed, now: now.get(key) ?? 0 }));
  return { fresh, stale };
}

export function renderAllowlist(violations: readonly Violation[]): string {
  const counts = countByKey(violations);
  const header = [
    '# TEST-INTERFERENCE-RATCHET 허용 목록 — 이 줄이 생긴 시점(2026-10-16)의 기존 위반 전수.',
    '# 형식: <꼴>\\t<파일>\\t<개수> · 개수가 «늘면» scripts/ratchets/test-interference-patterns.test.ts 가 실패한다.',
    '# ⛔ 새 위반을 여기 더하지 마라 — 꼴의 처방대로 고친다. 줄었으면 다시 쓴다:',
    `# ${UPDATE_COMMAND}`,
  ];
  return `${[...header, ...[...counts].sort(([a], [b]) => a.localeCompare(b)).map(([key, n]) => `${key}\t${n}`)].join('\n')}\n`;
}

export function formatViolation(v: Violation): string {
  return `${v.file}:${v.line} [${v.form}] ${v.text}\n    → ${FORMS[v.form]}`;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const started = performance.now();
  if (args.includes('--update-allowlist')) {
    const all = scanFiles(listTestFiles());
    writeFileSync(ALLOWLIST_PATH, renderAllowlist(all));
    console.log(`[test-interference] allowlist rewritten: ${countByKey(all).size} file·form entries · ${all.length} sites (${Math.round(performance.now() - started)}ms)`);
  } else {
    const files = args.filter((a) => !a.startsWith('--')).filter((f) => TEST_FILE.test(f));
    const scope = files.length ? new Set(files) : undefined;
    const scanned = files.length ? files : listTestFiles();
    const result = judge(scanFiles(scanned), parseAllowlist(readFileSync(ALLOWLIST_PATH, 'utf8')), scope);
    for (const v of result.fresh) console.log(formatViolation(v));
    if (result.stale.length) console.log(`[test-interference] ${result.stale.length} allowlist entries shrank — tighten with: ${UPDATE_COMMAND}`);
    console.log(`[test-interference] scanned ${scanned.length} test files · new violations ${result.fresh.length} (${Math.round(performance.now() - started)}ms)`);
    process.exitCode = result.fresh.length ? 1 : 0;
  }
}
