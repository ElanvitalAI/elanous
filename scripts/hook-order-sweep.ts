#!/usr/bin/env bun
/** Hook-order ruler: React hook calls that are not unconditional at the top level of their component.
 *
 *  ⛔⭐⭐⭐ 왜 있나 (2026-08-21 · `[F]` 15차):
 *    `#10804` 에서 `useCallback` 하나가 «조기 반환 뒤»에 놓였다. 빈 대화 렌더에서 훅 수가 갈렸고
 *    ***앱이 통째로 죽었다***. 그런데 시험 48개가 전부 초록이었다 —
 *    이 저장소의 PWA 시험은 `react-dom/server` 의 `renderToStaticMarkup` 으로 «한 번만» 그린다.
 *    ⇒ 📌 ***재렌더가 없으면 훅 순서 위반은 원리상 안 드러난다.*** 그리고 이 저장소엔 린터가 «없다»
 *    (eslint·biome 설정 전수 0건 · 2026-08-21 실측).
 *
 *  ⇒ 그래서 이 자는 «구문»만 본다. 타입도 런타임도 필요 없다 — 훅 규칙은 순수하게 위치의 문제다. */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

type Ts = typeof import('typescript');
type Node = import('typescript').Node;
type SourceFile = import('typescript').SourceFile;

/** ⛔ 세 갈래를 «구분해서» 센다 — 처방이 다르기 때문이다. */
export type HookViolationKind = 'after-early-return' | 'conditional' | 'nested-function';

export interface HookViolation {
  file: string;
  line: number;
  hook: string;
  owner: string;
  kind: HookViolationKind;
}

export interface HookOrderReport {
  scanRoots: string[];
  unavailableScopes: string[];
  filesScanned: number;
  ownersScanned: number;
  hookCallsScanned: number;
  violations: HookViolation[];
  elapsedSeconds: number;
}

class HookOrderSweepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HookOrderSweepError';
  }
}

function loadTypeScript(root: string): Promise<Ts> {
  const candidates = [resolve(root, 'node_modules/typescript/lib/typescript.js'), resolve(import.meta.dir, '../node_modules/typescript/lib/typescript.js')];
  const compiler = candidates.find(existsSync);
  if (!compiler) throw new HookOrderSweepError(`TypeScript compiler dependency was not found; searched ${candidates.join(', ')}; cannot measure root ${root}`);
  return import(pathToFileURL(compiler).href) as Promise<Ts>;
}

/** React 소스 파일. `.d.ts` 는 선언뿐이라 훅 호출이 없다. */
function isSourceCandidate(file: string): boolean {
  return (file.endsWith('.ts') || file.endsWith('.tsx')) && !file.endsWith('.d.ts');
}

function walkFiles(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry.startsWith('.')) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walkFiles(path, out);
    else if (isSourceCandidate(path)) out.push(path);
  }
  return out;
}

/** 훅 이름 규칙은 React 가 정한 것이다 — `use` 뒤에 대문자. `used`·`useful` 은 훅이 아니다. */
function isHookName(name: string): boolean {
  return /^use[A-Z]/.test(name);
}

/** 이 호출이 부르는 훅 이름. ⛔ 식별자 호출만 보면 `React.useState(…)` 를 통째로 놓친다 —
 *  이 저장소의 shadcn 컴포넌트들이 `import * as React` 로 그 형태를 쓴다(무인 리뷰 지적 · 2026-08-21).
 *  ⚠️ 그 형태는 `nonHooks` 고정점으로 못 거른다(수신자 본문을 못 본다) — 이름 규칙을 그대로 믿는다. */
function calledHookName(ts: Ts, node: import('typescript').CallExpression): { name: string; local: boolean } | undefined {
  if (ts.isIdentifier(node.expression)) return isHookName(node.expression.text) ? { name: node.expression.text, local: true } : undefined;
  if (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.name)) {
    return isHookName(node.expression.name.text) ? { name: node.expression.name.text, local: false } : undefined;
  }
  return undefined;
}

/** 훅을 «담을 수 있는» 자리 = 컴포넌트(대문자로 시작) 또는 커스텀 훅(`useX`). 그 밖에서 부르면 그 자체가 위반이다. */
function ownerName(ts: Ts, node: Node): string | undefined {
  if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.name) return node.name.text;
  const parent = node.parent;
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
    // ⛔ 대입식으로 이름을 얻는 컴포넌트도 있다 — `Subject = (props) => …`.
    //    `const` 선언만 보면 그 안의 훅이 전부 「중첩 함수」로 «오탐»된다(실측 3건 · 2026-08-21).
    if (parent && ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(parent.left)) return parent.left.text;
    if (parent && ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  }
  if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) return node.name.text;
  return undefined;
}

function isOwnerName(name: string | undefined): boolean {
  return Boolean(name) && (/^[A-Z]/.test(name!) || isHookName(name!));
}

function isFunctionLike(ts: Ts, node: Node): boolean {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node);
}

/** 이 노드와 소유자 사이에 «분기»가 있나 — 단축 평가 연산자의 오른쪽만 조건부다. */
function branchBetween(ts: Ts, node: Node, owner: Node): boolean {
  let child: Node = node;
  for (let current = node.parent; current && current !== owner; child = current, current = current.parent) {
    if (
      ts.isIfStatement(current)
      || ts.isConditionalExpression(current)
      || ts.isForStatement(current) || ts.isForOfStatement(current) || ts.isForInStatement(current)
      || ts.isWhileStatement(current) || ts.isDoStatement(current)
      || ts.isSwitchStatement(current)
      || ts.isTryStatement(current) || ts.isCatchClause(current)
      || (ts.isBinaryExpression(current)
        && child === current.right
        && (current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken || current.operatorToken.kind === ts.SyntaxKind.BarBarToken || current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken))
    ) return true;
  }
  return false;
}

/** 이 문장이 «자기 스코프에서» 반환하나. ⛔ 중첩 함수 안의 return 은 그 함수의 것이라 안 센다. */
function returnsInOwnScope(ts: Ts, statement: Node): boolean {
  let found = false;
  const visit = (node: Node): void => {
    if (found || isFunctionLike(ts, node)) return;
    if (ts.isReturnStatement(node)) { found = true; return; }
    ts.forEachChild(node, visit);
  };
  visit(statement);
  return found;
}

/** 소유자 본문에서 «조기 반환»이 가능한 문장들의 위치.
 *
 *  ⛔📏 1차판은 여기서 틀렸다 — 맨 위 줄의 bare `return` 만 셌다. 그런데 실물의 조기 반환은
 *  거의 언제나 `if (조건) { return … }` 라 그 return 은 IfStatement «안»에 있다.
 *  `#10804` 을 재구성해 대 봤더니 0 을 냈고, 그래서 이 함수가 고쳐졌다. */
function earlyReturnStarts(ts: Ts, owner: Node): number[] {
  const body = (owner as import('typescript').FunctionLikeDeclaration).body;
  if (!body || !ts.isBlock(body)) return [];
  return body.statements.filter((statement) => returnsInOwnScope(ts, statement)).map((statement) => statement.getStart());
}

/** 훅이 «어느 최상위 문장에» 속하나.
 *
 *  ⛔📏 2차판은 훅 «자신»의 위치로 비교해서 `return useQuery({…})` 를 전부 「반환 뒤」로 셌다
 *  (실측 45건이 그 오탐이었다). 훅이 그 반환문 «안»에 있으면 그 반환은 훅보다 앞이 아니다. */
function enclosingStatementStart(ts: Ts, node: Node, owner: Node): number {
  const body = (owner as import('typescript').FunctionLikeDeclaration).body;
  let current: Node | undefined = node;
  while (current && current.parent && current.parent !== body) current = current.parent;
  return current?.getStart() ?? node.getStart();
}

/** 이 파일이 «자기 안에서» 선언한 함수들 — 이름 → 본문. import 한 것은 여기 없다. */
function localFunctions(ts: Ts, source: SourceFile): Map<string, Node> {
  const locals = new Map<string, Node>();
  const visit = (node: Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name) locals.set(node.name.text, node);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && isFunctionLike(ts, node.initializer)) locals.set(node.name.text, node.initializer);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return locals;
}

/** 지역 선언 중 «훅이 아닌» 이름.
 *
 *  ⛔📏 훅 이름 규칙만 보면 `use` 로 시작하는 지역 «핸들러»를 훅으로 읽는다
 *  (실측: `TerminalRepl.tsx:396` 의 `useQuickCmd` 는 클릭 핸들러다).
 *  ⇒ ***훅이란 훅을 부르는 함수다.*** 그래서 고정점으로 가른다 — 훅을 하나도 안 부르는 지역 함수는 훅이 아니다.
 *  ⛔ import 한 이름은 본문을 못 보므로 판단하지 않는다. 그쪽은 이름 규칙을 그대로 믿는다. */
function localNonHooks(ts: Ts, source: SourceFile): Set<string> {
  const locals = localFunctions(ts, source);
  const callees = new Map<string, string[]>();
  for (const [name, body] of locals) {
    const calls: string[] = [];
    const visit = (node: Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) calls.push(node.expression.text);
      ts.forEachChild(node, visit);
    };
    visit(body);
    callees.set(name, calls);
  }
  const callsHook = new Set<string>();
  for (let changed = true; changed;) {
    changed = false;
    for (const [name, calls] of callees) {
      if (callsHook.has(name)) continue;
      if (calls.some((callee) => (isHookName(callee) && !locals.has(callee)) || callsHook.has(callee))) {
        callsHook.add(name);
        changed = true;
      }
    }
  }
  return new Set([...locals.keys()].filter((name) => isHookName(name) && !callsHook.has(name)));
}

export async function sweepHookOrder(root = process.cwd(), scopes: readonly string[] = ['apps/pwa/src']): Promise<HookOrderReport> {
  const startedAt = performance.now();
  const ts = await loadTypeScript(resolve(root));
  root = resolve(root);
  const present = scopes.filter((scope) => existsSync(resolve(root, scope)));
  const files = present.flatMap((scope) => walkFiles(resolve(root, scope), []));
  const violations: HookViolation[] = [];
  const owners = new Set<string>();
  let hookCallsScanned = 0;

  for (const file of files) {
    const source: SourceFile = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const nonHooks = localNonHooks(ts, source);
    const record = (node: import('typescript').CallExpression, hook: string, label: string | undefined, kind: HookViolationKind): void => {
      violations.push({
        file: relative(root, file),
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        hook,
        owner: label ?? '<top level>',
        kind,
      });
    };

    /** `host` = 훅을 «담을 수 있는» 가장 가까운 함수. 없으면 undefined — 그 안의 훅은 매 렌더에 안 돈다.
     *  `label` = 사람이 읽을 이름. ⛔ 둘을 한 변수로 쓰면 중첩 함수가 컴포넌트로 «읽힌다»(2026-08-21 실측). */
    const visit = (node: Node, host: Node | undefined, hostName: string | undefined, label: string | undefined, returns: number[]): void => {
      if (isFunctionLike(ts, node) && node !== host) {
        const inner = ownerName(ts, node);
        if (isOwnerName(inner)) {
          owners.add(`${relative(root, file)}#${inner}`);
          ts.forEachChild(node, (child) => visit(child, node, inner, inner, earlyReturnStarts(ts, node)));
          return;
        }
        // ⛔ 훅을 담을 수 없는 중첩 함수 — 안에서 부른 훅은 매 렌더에 안 돈다.
        ts.forEachChild(node, (child) => visit(child, node, undefined, inner ?? label, []));
        return;
      }
      const called = ts.isCallExpression(node) ? calledHookName(ts, node) : undefined;
      if (called && !(called.local && nonHooks.has(called.name))) {
        const call = node as import('typescript').CallExpression;
        hookCallsScanned++;
        if (!host || !hostName) record(call, called.name, label, 'nested-function');
        else if (branchBetween(ts, call, host)) record(call, called.name, label, 'conditional');
        else if (returns.some((start) => start < enclosingStatementStart(ts, call, host))) record(call, called.name, label, 'after-early-return');
      }
      ts.forEachChild(node, (child) => visit(child, host, hostName, label, returns));
    };

    ts.forEachChild(source, (child) => visit(child, undefined, undefined, undefined, []));
  }

  return {
    scanRoots: present,
    unavailableScopes: scopes.filter((scope) => !present.includes(scope)),
    filesScanned: files.length,
    ownersScanned: owners.size,
    hookCallsScanned,
    violations: violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
    elapsedSeconds: (performance.now() - startedAt) / 1000,
  };
}

function kindCount(report: HookOrderReport, kind: HookViolationKind): number {
  return report.violations.filter((violation) => violation.kind === kind).length;
}

export function formatHookOrderReport(report: HookOrderReport): string[] {
  return [
    `[hook-order] denominator: hook calls=${report.hookCallsScanned}; components and custom hooks=${report.ownersScanned}; files=${report.filesScanned}; ruler=identifier call matching /^use[A-Z]/ in TypeScript sources under the scanned scopes; scope=${report.scanRoots.join(', ') || 'none'}; unmeasured scopes=${report.unavailableScopes.join(', ') || 'none'}`,
    `[hook-order] after early return: ${kindCount(report, 'after-early-return')}; ruler=hook call positioned after a return statement in the top-level statement list of its component, so a render that takes the early return calls fewer hooks`,
    `[hook-order] conditional: ${kindCount(report, 'conditional')}; ruler=hook call nested inside a branch, loop, switch, try, or the right operand of &&, ||, or ?? within its component`,
    `[hook-order] nested function: ${kindCount(report, 'nested-function')}; ruler=hook call inside a function that is neither a component nor a custom hook, so it does not run on every render of the surrounding component`,
    `[hook-order] imported hook identity: not-measured; ruler=a locally declared function that calls no hook is excluded because a hook is a function that calls hooks, but an imported name and a property access such as React.useState are judged by the naming convention React itself enforces; a hook renamed on import to a name that does not start with use is outside this ruler and outside React's own convention`,
    `[hook-order] elapsed: ${report.elapsedSeconds.toFixed(2)}s`,
  ];
}

if (import.meta.main) {
  const flags = new Set(['--strict', '--list']);
  const rootArg = process.argv.slice(2).find((argument) => !flags.has(argument));
  const root = resolve(rootArg ?? process.cwd());
  try {
    const report = await sweepHookOrder(root);
    const lines = formatHookOrderReport(report);
    lines[0] = `${lines[0]}; root=${root}`;
    for (const line of lines) console.log(line);
    if (process.argv.includes('--list')) {
      for (const violation of report.violations) {
        console.log(`[hook-order] site ${violation.file}:${violation.line}; hook=${violation.hook}; owner=${violation.owner}; kind=${violation.kind}`);
      }
    }
    if (process.argv.includes('--strict') && report.violations.length > 0) process.exitCode = 1;
  } catch (error) {
    const message = error instanceof Error ? error.message.replace(/\s+/g, ' ') : String(error);
    console.log(`[hook-order] denominator: unavailable; root=${root}; ruler=identifier call matching /^use[A-Z]/ in TypeScript sources under the scanned scopes`);
    console.log(`[hook-order] cannot measure root=${root}; reason=${message}`);
    process.exitCode = 1;
  }
}
