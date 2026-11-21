import { expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

const sourceRoot = resolve(import.meta.dir, '../src');
const dashboardRoot = resolve(sourceRoot, 'dashboard');
const compilerOptions: ts.CompilerOptions = {
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
};

function productionTypescriptFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) return dir === sourceRoot && entry.name === 'dashboard' ? [] : productionTypescriptFiles(path);
    return entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.(?:test|spec|d)\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

function resolvesIntoDashboard(sourcePath: string, specifier: string): boolean {
  const resolved = ts.resolveModuleName(specifier, sourcePath, compilerOptions, ts.sys).resolvedModule?.resolvedFileName;
  // Directory imports can be resolved by the runtime even when TypeScript does not find an index file.
  const target = resolved ?? (specifier.startsWith('.') ? resolve(dirname(sourcePath), specifier) : undefined);
  if (!target) return false;
  const fromDashboard = relative(dashboardRoot, target);
  return fromDashboard === '' || (fromDashboard !== '..' && !fromDashboard.startsWith(`..${sep}`));
}

function dashboardEdges(path: string, text: string): string[] {
  const edges: string[] = [];
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const file = `src/${relative(sourceRoot, path).split(sep).join('/')}`;
  const visit = (node: ts.Node): void => {
    let specifier: string | undefined;
    let kind: 'static' | 'dynamic' | 'require' | undefined;
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      specifier = node.moduleSpecifier.text;
      kind = 'static';
    } else if (ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) kind = 'dynamic';
      else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') kind = 'require';
      else if (ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'require'
        && node.expression.name.text === 'resolve') kind = 'require';
      if (kind) specifier = node.arguments[0].text;
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
      && ts.isStringLiteral(node.argument.literal)) {
      specifier = node.argument.literal.text;
      kind = 'static';
    }
    if (specifier && kind && resolvesIntoDashboard(path, specifier)) edges.push(`${file} ${kind} ${specifier}`);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return edges;
}

test('classic dashboard has one named root launcher seam and no other production imports', () => { // 출처: #38824 스캔 시험 6.8s 실측(부하 호스트 · bun 기본 5s 초과) — timeout 부여(tsc 오버로드는 숫자 인자 형태만)
  const edges = productionTypescriptFiles(sourceRoot).flatMap((path) => dashboardEdges(path, readFileSync(path, 'utf8')));
  // #38701 TURN-FIELD-BUG-3 · #38298 A217 요청 계약 · #38210 TURN-PACING · #37875 graph-cli owner 바인딩(2026-11-18
  // known-fail 묶음5: 지연 적재로 전환 — 정적 import 면 elanous --help 파싱만으로 plugin-route-adapter가 즉시 돈다) ·
  // #38069 ELN-SELF-TIMER-WATCH · #38186 seat AGENTS.md 적재 · #38006 TURN-ROUTE-PIN — 0.3.29 착지군이
  // 대시보드 내부 계약 모듈(플러그인 경로 어댑터·commitment-ledger·turn-life 사건·seat 부트) 을 참조하게 했다.
  // CLASSIC-TUI-RETIRE-SWEEP ② — next-mail-wake 의 seat-boot seam 을 정본 src/seat/seat-boot-preamble 으로 전환해 목록에서 제거.
  // #39242 ELN-SEAT-AUTOWAKE-BUDGET — next-mail-wake 의 budget seam 등록 누락 보충: fbd9c03ade 착지가 이 목록을 갱신하지 않아 main known-fail.
  // CLASSIC-TUI-RETIRE-SWEEP ① 2단계 — goal-continue 의 turn-outcome-shadow seam 을 정본 src/commitment/turn-outcome-shadow 로 전환해 목록에서 제거.
  expect(edges.sort()).toEqual([
    'src/graph-runner/graph-cli-owner.ts dynamic ../dashboard/plugin-route-adapter.js',
    'src/index.ts dynamic ./dashboard/index.js',
    'src/msg/self-timer-watch.ts static ../dashboard/input/commitment-ledger.js',
    'src/repl/index.ts dynamic ../dashboard/plugin-route-adapter.js',
    'src/repl/index.ts dynamic ../dashboard/plugin-route-adapter.js',
    'src/repl/index.ts dynamic ../dashboard/plugin-route-adapter.js',
    'src/tui-client/next-mail-wake.ts static ../dashboard/input/seat-autowake-budget.js',
    'src/tui/entry.ts dynamic ../dashboard/seat-local-instructions.js',
    'src/tui/seat-mail-boot.ts static ../dashboard/input/seat-task-decompose.js',
  ]);
}, 60_000); // 출처: #38824 — 스캔 6.8s > bun 기본 5s(부하 호스트 실측) · 저장소 관례 숫자 인자

test('classic seam scan resolves directory imports and require calls into dashboard', () => {
  const path = resolve(sourceRoot, 'ux-sim/classic-bypass-example.ts');
  expect(dashboardEdges(path, "import { showDashboard } from '../dashboard';")).toEqual([
    'src/ux-sim/classic-bypass-example.ts static ../dashboard',
  ]);
  expect(dashboardEdges(path, "const dashboard = require('../dashboard/index.js');")).toEqual([
    'src/ux-sim/classic-bypass-example.ts require ../dashboard/index.js',
  ]);
});
