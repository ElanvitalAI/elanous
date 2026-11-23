/**
 * R-TST23 mock.module 복구 ratchet 게이트.
 *
 * bun의 mock.module()은 process-wide 모듈 레지스트리를 바꾸며 mock.restore()는 이를 되돌리지
 * 않는다. 유효한 복구는 afterAll 콜백의 마지막으로 실행 가능한 해당 모듈 mock.module()이 원본을
 * factory에서 직접 반환하는 형태다. 원본은 namespace import의 펼친 스냅샷({ ...module }) 또는
 * node:module named import에서 유래한 createRequire로 미리 얻은 값이어야 한다. 조건부·도달 불가
 * 복구와 이후 afterAll 재-mock은 복구로 인정하지 않는다.
 *
 * 정책: 기존 부채는 파일별 baseline으로 허용하고 새 파일/증가만 막는다. --update는 현재
 * 관측값을 재스냅샷하여 수복 뒤 baseline을 낮춘다.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, relative } from 'node:path';
import ts from 'typescript';

const ROOT = join(import.meta.dir, '..');
const BASELINE = join(import.meta.dir, 'mock-module-restore-baseline.txt');
const TEST_FILE = /\.test\.tsx?$/;

type RestoreScanEntry = { count: number; modules: string[] };
type MockModuleRestoreGateIo = {
  args?: string[];
  cwd?: string;
  compareRef?: string;
  scan?: () => Map<string, RestoreScanEntry>;
  loadBaseline?: () => Map<string, number>;
  writeBaseline?: (entries: Map<string, RestoreScanEntry>) => void;
  log?: (message: string) => void;
  error?: (message: string) => void;
};

type ModuleOperation = { moduleName: string; restores: boolean };

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    // ⛔ `.claude/` 는 «다른 세션의 워크트리»가 사는 곳이다(`.git/info/exclude` 가 이미 무시한다).
    //    저장소 «전체 사본»이 들어 있어, 안 거르면 이 게이트의 정의역이 내 저장소가 아니게 된다
    //    — 실측 2026-09-22: 보이는 시험파일 13,074 중 8,504(65%)가 남의 워크트리였고
    //    빨강 50줄이 «전부» 거기서 나왔다(본 트리 소속 0).
    if (name === 'node_modules' || name === '.git' || name === '.elanous-test' || name === '.claude') continue;
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) walk(path, out);
    else if (TEST_FILE.test(name)) out.push(path);
  }
}

function stringArgument(call: ts.CallExpression, index: number): string | null {
  const argument = call.arguments[index];
  return argument && ts.isStringLiteral(argument) ? argument.text : null;
}

function isMockModuleCall(node: ts.Node): node is ts.CallExpression {
  return ts.isCallExpression(node)
    && ts.isPropertyAccessExpression(node.expression)
    && ts.isIdentifier(node.expression.expression)
    && node.expression.expression.text === 'mock'
    && node.expression.name.text === 'module';
}

function isAfterAllCall(node: ts.Node): node is ts.CallExpression {
  return ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'afterAll';
}

function isFunction(node: ts.Node): boolean {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node);
}

function factoryReturnedIdentifier(factory: ts.Expression | undefined): string | null {
  if (!factory || (!ts.isArrowFunction(factory) && !ts.isFunctionExpression(factory))) return null;
  if (ts.isIdentifier(factory.body)) return factory.body.text;
  if (!ts.isBlock(factory.body)) return null;
  const returns = factory.body.statements.filter(ts.isReturnStatement);
  return returns.length === 1 && returns[0]!.expression && ts.isIdentifier(returns[0]!.expression)
    ? returns[0]!.expression.text
    : null;
}

function importedCreateRequireNames(file: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== 'node:module') continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if (element.propertyName?.text === 'createRequire' || (!element.propertyName && element.name.text === 'createRequire')) names.add(element.name.text);
    }
  }
  return names;
}

function collectOriginals(file: ts.SourceFile): Map<string, string> {
  const namespaceImports = new Map<string, string>();
  const createRequireNames = importedCreateRequireNames(file);
  const requireBindings = new Set<string>();
  const originals = new Map<string, string>();

  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement)
      && statement.importClause?.namedBindings
      && ts.isNamespaceImport(statement.importClause.namedBindings)
      && ts.isStringLiteral(statement.moduleSpecifier)) {
      namespaceImports.set(statement.importClause.namedBindings.name.text, statement.moduleSpecifier.text);
    }

    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      if (statement.declarationList.flags & ts.NodeFlags.Const
        && ts.isCallExpression(declaration.initializer)
        && ts.isIdentifier(declaration.initializer.expression)
        && createRequireNames.has(declaration.initializer.expression.text)) {
        requireBindings.add(declaration.name.text);
      }
      if (ts.isObjectLiteralExpression(declaration.initializer) && declaration.initializer.properties.length === 1) {
        const property = declaration.initializer.properties[0];
        if (property && ts.isSpreadAssignment(property) && ts.isIdentifier(property.expression)) {
          const moduleName = namespaceImports.get(property.expression.text);
          if (moduleName) originals.set(declaration.name.text, moduleName);
        }
      }
      if (ts.isCallExpression(declaration.initializer)
        && ts.isIdentifier(declaration.initializer.expression)
        && requireBindings.has(declaration.initializer.expression.text)) {
        const moduleName = stringArgument(declaration.initializer, 0);
        if (moduleName) originals.set(declaration.name.text, moduleName);
      }
    }
  }
  return originals;
}

function isStaticTrue(expression: ts.Expression): boolean {
  return expression.kind === ts.SyntaxKind.TrueKeyword;
}

function isStaticFalse(expression: ts.Expression): boolean {
  return expression.kind === ts.SyntaxKind.FalseKeyword;
}

function collectGuaranteedOperations(node: ts.Node, originals: Map<string, string>, operations: ModuleOperation[]): boolean {
  if (ts.isReturnStatement(node) || ts.isThrowStatement(node)) return false;
  if (ts.isBlock(node) || ts.isSourceFile(node)) {
    for (const statement of node.statements) {
      if (!collectGuaranteedOperations(statement, originals, operations)) return false;
    }
    return true;
  }
  if (ts.isIfStatement(node)) {
    if (isStaticTrue(node.expression)) return collectGuaranteedOperations(node.thenStatement, originals, operations);
    if (isStaticFalse(node.expression)) return node.elseStatement ? collectGuaranteedOperations(node.elseStatement, originals, operations) : true;
    return true;
  }
  if (isFunction(node)) return true;
  if (isMockModuleCall(node)) {
    const moduleName = stringArgument(node, 0);
    const originalName = factoryReturnedIdentifier(node.arguments[1]);
    if (moduleName) operations.push({ moduleName, restores: !!originalName && originals.get(originalName) === moduleName });
    return true;
  }
  ts.forEachChild(node, child => collectGuaranteedOperations(child, originals, operations));
  return true;
}

function collectAfterAllOperations(file: ts.SourceFile, originals: Map<string, string>): ModuleOperation[] {
  const operations: ModuleOperation[] = [];
  for (const statement of file.statements) {
    const call = ts.isExpressionStatement(statement) ? statement.expression : statement;
    if (!isAfterAllCall(call)) continue;
    const callback = call.arguments[0];
    if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) collectGuaranteedOperations(callback.body, originals, operations);
  }
  return operations;
}

function collectMockedOutsideAfterAll(file: ts.SourceFile): Set<string> {
  const mocked = new Set<string>();
  const visit = (node: ts.Node, inAfterAll = false): void => {
    if (isAfterAllCall(node)) return;
    if (isMockModuleCall(node) && !inAfterAll) {
      const moduleName = stringArgument(node, 0);
      if (moduleName) mocked.add(moduleName);
    }
    ts.forEachChild(node, child => visit(child, inAfterAll));
  };
  visit(file);
  return mocked;
}

export function scanMockModuleRestoreCandidates(source: string): string[] {
  const file = ts.createSourceFile('candidate.test.ts', source, ts.ScriptTarget.Latest, true);
  const originals = collectOriginals(file);
  const mocked = collectMockedOutsideAfterAll(file);
  const finalOperations = new Map<string, ModuleOperation>();
  for (const operation of collectAfterAllOperations(file, originals)) finalOperations.set(operation.moduleName, operation);
  return [...mocked].filter(moduleName => !finalOperations.get(moduleName)?.restores);
}

function scan(root = ROOT): Map<string, RestoreScanEntry> {
  const files: string[] = [];
  walk(root, files);
  const entries = new Map<string, RestoreScanEntry>();
  for (const file of files) {
    const modules = scanMockModuleRestoreCandidates(readFileSync(file, 'utf8'));
    if (modules.length > 0) entries.set(relative(root, file), { count: modules.length, modules });
  }
  return entries;
}

function loadBaseline(root = ROOT): Map<string, number> {
  const entries = new Map<string, number>();
  const baseline = join(root, 'scripts', 'mock-module-restore-baseline.txt');
  if (!existsSync(baseline)) return entries;
  for (const line of readFileSync(baseline, 'utf8').split('\n')) {
    const text = line.trim();
    if (!text || text.startsWith('#')) continue;
    const [count, file] = text.split('\t', 2);
    if (file) entries.set(file, Number.parseInt(count, 10) || 0);
  }
  return entries;
}

function writeBaseline(entries: Map<string, RestoreScanEntry>): void {
  const total = [...entries.values()].reduce((sum, entry) => sum + entry.count, 0);
  const lines = [...entries.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([file, entry]) => `${entry.count}\t${file}`);
  writeFileSync(BASELINE, [
    '# R-TST23 mock.module 복구 baseline (파일별 미복구 모듈 수).',
    '# 신규/증가만 CI 실패; 수복 뒤 --update로 baseline을 낮춘다.',
    `# total=${total} · files=${entries.size}`,
    '',
    ...lines,
    '',
  ].join('\n'));
}

function parseChangedFiles(args: readonly string[]): Set<string> | null {
  const changedFilesAt = args.indexOf('--changed-files');
  if (changedFilesAt < 0) return null;
  const files: string[] = [];
  for (const arg of args.slice(changedFilesAt + 1)) {
    if (arg.startsWith('--')) break;
    files.push(arg);
  }
  return new Set(files);
}

/** Read the actual baseline tree, not a possibly stale debt snapshot in the candidate. */
function scanBaselineRef(root: string, ref: string, files: Iterable<string>): Map<string, RestoreScanEntry> {
  const env = { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_COMMON_DIR: undefined, GIT_NO_LAZY_FETCH: '1' };
  const git = (args: string[]) => spawnSync('git', args, { cwd: root, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const resolved = git(['rev-parse', '--verify', `${ref}^{commit}`]);
  const sha = resolved.stdout?.trim();
  if (resolved.status !== 0 || !sha || !/^[a-f0-9]{40}$/i.test(sha)) throw new Error('기준 커밋을 확인할 수 없습니다');
  const listing = git(['ls-tree', '-r', '-z', '--name-only', sha]);
  if (listing.status !== 0) throw new Error('기준 트리 파일을 읽을 수 없습니다');
  const tracked = new Set(listing.stdout.split('\0').filter(Boolean));
  const result = new Map<string, RestoreScanEntry>();
  for (const file of files) {
    if (!tracked.has(file)) continue;
    const show = git(['show', `${sha}:${file}`]);
    if (show.status !== 0) throw new Error(`기준 파일을 읽을 수 없습니다: ${file}`);
    const modules = scanMockModuleRestoreCandidates(show.stdout);
    if (modules.length) result.set(file, { count: modules.length, modules });
  }
  return result;
}

export function runMockModuleRestoreGate(io: MockModuleRestoreGateIo = {}): number {
  const log = io.log ?? console.log;
  const error = io.error ?? console.error;
  const args = io.args ?? process.argv.slice(2);
  const changedFiles = parseChangedFiles(args);
  if (changedFiles !== null && args.includes('--update')) {
    error('[mock-module-restore-gate] FAIL — --changed-files 와 --update 를 함께 쓸 수 없습니다.');
    return 1;
  }
  const root = io.cwd ?? ROOT;
  const scanned = io.scan ? io.scan() : scan(root);
  const current = new Map([...scanned.entries()].filter(([file]) => changedFiles === null || changedFiles.has(file)));
  const total = [...current.values()].reduce((sum, entry) => sum + entry.count, 0);
  log(`[mock-module-restore-gate] scanned ${current.size} violating file(s); ${total} un-restored module mock(s).`);
  if (args.includes('--update')) {
    (io.writeBaseline ?? writeBaseline)(current);
    log(`[mock-module-restore-gate] baseline 갱신 — ${current.size} 파일 · ${total} 미복구 mock.module.`);
    return 0;
  }
  if (io.compareRef) {
    try {
      const baseline = scanBaselineRef(root, io.compareRef, current.keys());
      const violations = [...current].flatMap(([file, entry]) => {
        const prior = new Set(baseline.get(file)?.modules ?? []);
        const introduced = entry.modules.filter(module => !prior.has(module));
        return introduced.length ? [{ file, introduced }] : [];
      });
      if (violations.length) {
        error('[mock-module-restore-gate] FAIL — 기준 커밋에 없는 미복구 mock.module 감지.');
        for (const { file, introduced } of violations) error(`  ${file}: ${introduced.join(', ')}`);
        return 1;
      }
      log('[mock-module-restore-gate] PASS — 기준 커밋 대비 신규 미복구 mock.module 없음.');
      return 0;
    } catch (cause) {
      error(`[mock-module-restore-gate] FAIL — 기준 측정 불가: ${cause instanceof Error ? cause.message : String(cause)}`);
      return 1;
    }
  }
  const loadedBaseline = io.loadBaseline ? io.loadBaseline() : loadBaseline(root);
  const baseline = changedFiles === null
    ? loadedBaseline
    : new Map([...loadedBaseline.entries()].filter(([file]) => changedFiles.has(file)));
  if (baseline.size === 0 && changedFiles === null) {
    error(`[mock-module-restore-gate] FAIL — baseline이 없거나 비어 있습니다: ${relative(ROOT, BASELINE)}. --update로 현재 부채를 명시적으로 스냅샷하십시오.`);
    return 1;
  }
  const violations = [...current.entries()].filter(([file, entry]) => entry.count > (baseline.get(file) ?? 0));
  const ratcheted = [...baseline.entries()].filter(([file, allowed]) => (current.get(file)?.count ?? 0) < allowed);
  if (violations.length > 0) {
    error('[mock-module-restore-gate] FAIL — 신규 mock.module 미복구 감지.');
    for (const [file, entry] of violations) error(`  ${file}: ${baseline.get(file) ?? 0} → ${entry.count} (${entry.modules.join(', ')})`);
    return 1;
  }
  log(`[mock-module-restore-gate] PASS — 신규 미복구 mock.module 없음 (baseline ${total} 유지${ratcheted.length ? ' · 수복됨→--update 권장' : ''}).`);
  return 0;
}

if (import.meta.main) process.exit(runMockModuleRestoreGate());
