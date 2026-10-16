import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { SPAWN_SYNC_MAX_BUFFER, spawnSyncText } from '../src/util/spawn-sync-output.js';

const ROOT = resolve(import.meta.dir, '..');

test('spawnSyncText reads a 2 MiB child output without truncation', () => {
  const output = spawnSyncText('bun', ['-e', 'process.stdout.write("x".repeat(2 * 1024 * 1024))']);
  expect(output.length).toBe(2 * 1024 * 1024);
  expect(output).toBe('x'.repeat(2 * 1024 * 1024));
});

test('spawnSyncText rejects a small maxBuffer rather than returning partial output', () => {
  expect(() => spawnSyncText('bun', ['-e', 'process.stdout.write("x".repeat(2 * 1024 * 1024))'],
    { encoding: 'utf8', maxBuffer: 1024 })).toThrow(/ENOBUFS|maxBuffer|buffer/i);
});

test('repository git ls-files spawnSync readers specify maxBuffer or use spawnSyncText', () => {
  const args = ['-l', 'ls-files', '.', '-g', '*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'];
  const files = execFileSync('rg', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).trim().split('\n').filter(Boolean);
  expect(files.length).toBeGreaterThan(0);
  const violations: string[] = [];
  let covered = 0;
  for (const file of files) {
    const source = ts.createSourceFile(file, readFileSync(resolve(ROOT, file), 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
          (node.expression.text === 'spawnSync' || node.expression.text === 'spawnSyncText') &&
          node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === 'git' &&
          node.arguments[1] && ts.isArrayLiteralExpression(node.arguments[1]) &&
          node.arguments[1].elements.some((arg) => ts.isStringLiteral(arg) && arg.text === 'ls-files')) {
        covered++;
        const opts = node.arguments[2];
        if (node.expression.text === 'spawnSync' && (!opts || !ts.isObjectLiteralExpression(opts) ||
            !opts.properties.some((property) => ts.isPropertyAssignment(property) &&
              (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) && property.name.text === 'maxBuffer'))) {
          violations.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect(covered).toBeGreaterThan(0);
  expect(violations).toEqual([]);
});

/**
 * Ratchet (0.2.30 HARD #3 · OP #8875 ②): every node `spawnSync` in the harness · Pod · gate trees must
 * either set `maxBuffer` (SPAWN_SYNC_MAX_BUFFER from src/util/spawn-sync-output.ts, or a bigger literal)
 * or not pipe stdout (`stdio: 'inherit' | 'ignore'`). Node's 1 MiB default silently truncates large output.
 * `Bun.spawnSync` is out of scope (it buffers without the 1 MiB cap).
 * Callees: `spawnSync`, its import aliases from `node:child_process` (`import { spawnSync as run }`), and `<x>.spawnSync`.
 * An `options` identifier resolves to its nearest-scope binding (block `const`/`let`, for/for-of/for-in, function
 * parameter, catch clause); a binding whose value is not an object literal is «unknown» and counts as unguarded.
 * Known limits (out of scope · OP #8907): namespace imports are only seen through `<ns>.spawnSync`; dynamic calls,
 * re-exports, functions stored in other variables, and `let` reassignment are not traced.
 * The allowlist only shrinks: counts must match exactly, so a fixed file has to drop its entry.
 */
const MAX_BUFFER_SCOPE = ['src/task-orchestrator', 'src/self-implement', 'scripts/release-loop', 'src/harness'];
const DEFERRED_UNGUARDED: Record<string, { count: number; reason: string }> = {
  'scripts/release-loop/gate-partial.ts': { count: 1, reason: 'OPEN #27819 touches this file' },
  'scripts/release-loop/gate-recheck-plan-node.ts': { count: 1, reason: 'OPEN #27819 touches this file' },
  'scripts/release-loop/resume-release.ts': { count: 2, reason: 'OPEN #28130 touches this file' },
  'scripts/release-loop/unattended-release.ts': { count: 1, reason: 'OPEN #28472 · #28130 touch this file' },
  'scripts/release-loop/version-node.ts': { count: 3, reason: 'OPEN #28293 touches this file' },
  'src/harness/harness-substrate-default.ts': { count: 1, reason: 'OPEN #28060 touches this file' },
  'src/self-implement/host-regate.ts': { count: 2, reason: 'OPEN #27484 touches this file' },
  'src/self-implement/orchestrator.ts': { count: 1, reason: 'OPEN #28434 · #28411 · #28252 · #28192 and more touch this file' },
  'src/task-orchestrator/surfaces/pod-command-job.ts': { count: 1, reason: 'OPEN #28370 · #27828 · #27817 · #27810 touch this file' },
  'src/task-orchestrator/surfaces/pod-pool.ts': { count: 5, reason: 'OPEN #27664 touches this file' },
  'src/task-orchestrator/surfaces/self-implement-pod.ts': { count: 3, reason: 'OPEN #28370 · #28277 · #28218 · #28188 and more touch this file' },
};

const propertyName = (property: ts.ObjectLiteralElementLike): string | undefined =>
  property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) ? property.name.text : undefined;

const STDOUT_NOT_PIPED = new Set(['inherit', 'ignore']);
function optionsAreGuarded(options: ts.ObjectLiteralExpression): boolean {
  for (const property of options.properties) {
    const name = propertyName(property);
    if (name === 'maxBuffer') return true;
    if (name === 'stdio' && ts.isPropertyAssignment(property)) {
      const value = property.initializer;
      if (ts.isStringLiteral(value) && STDOUT_NOT_PIPED.has(value.text)) return true;
      if (ts.isArrayLiteralExpression(value)) {
        const stdout = value.elements[1];
        if (stdout && ts.isStringLiteral(stdout) && STDOUT_NOT_PIPED.has(stdout.text)) return true;
      }
    }
  }
  return false;
}

const bindsName = (binding: ts.BindingName, name: string): boolean =>
  ts.isIdentifier(binding) ? binding.text === name
    : binding.elements.some((element) => !ts.isOmittedExpression(element) && bindsName(element.name, name));

/** The binding of `name` declared directly in `scope`: found=false (keep walking), or found with its object literal (undefined = unknown value). */
function bindingInScope(scope: ts.Node, name: string): { found: boolean; literal?: ts.ObjectLiteralExpression } {
  const fromDeclarations = (declarations: readonly ts.VariableDeclaration[]) => {
    for (const declaration of declarations) {
      if (!bindsName(declaration.name, name)) continue;
      const literal = ts.isIdentifier(declaration.name) && declaration.initializer && ts.isObjectLiteralExpression(declaration.initializer)
        ? declaration.initializer : undefined;
      return { found: true, literal };
    }
    return { found: false };
  };
  if (ts.isFunctionLike(scope) && scope.parameters.some((param) => bindsName(param.name, name))) return { found: true };
  if (ts.isCatchClause(scope) && scope.variableDeclaration && bindsName(scope.variableDeclaration.name, name)) return { found: true };
  if ((ts.isForStatement(scope) || ts.isForOfStatement(scope) || ts.isForInStatement(scope)) &&
      scope.initializer && ts.isVariableDeclarationList(scope.initializer)) {
    const hit = fromDeclarations(scope.initializer.declarations);
    if (hit.found) return ts.isForStatement(scope) ? hit : { found: true };
  }
  const statements = ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isModuleBlock(scope) || ts.isCaseClause(scope) || ts.isDefaultClause(scope)
    ? scope.statements : undefined;
  for (const statement of statements ?? []) {
    if (!ts.isVariableStatement(statement)) continue;
    const hit = fromDeclarations(statement.declarationList.declarations);
    if (hit.found) return hit;
  }
  return { found: false };
}

/** Resolve an identifier `options` argument to the object literal bound in the nearest enclosing scope (undefined = unknown). */
function resolveOptionsBinding(name: string, from: ts.Node): ts.ObjectLiteralExpression | undefined {
  for (let scope: ts.Node | undefined = from.parent; scope; scope = scope.parent) {
    const binding = bindingInScope(scope, name);
    if (binding.found) return binding.literal;
  }
  return undefined;
}

/** Local names bound to child_process `spawnSync` (`spawnSync` itself plus `import { spawnSync as X }` aliases). */
function spawnSyncNames(source: ts.SourceFile): Set<string> {
  const names = new Set(['spawnSync']);
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) ||
        !['node:child_process', 'child_process'].includes(statement.moduleSpecifier.text)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if ((element.propertyName ?? element.name).text === 'spawnSync') names.add(element.name.text);
    }
  }
  return names;
}

function unguardedSpawnSyncLinesInText(file: string, text: string): number[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const names = spawnSyncNames(source);
  const lines: number[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isNodeSpawnSync = (ts.isIdentifier(callee) && names.has(callee.text)) ||
        (ts.isPropertyAccessExpression(callee) && callee.name.text === 'spawnSync' &&
          !(ts.isIdentifier(callee.expression) && callee.expression.text === 'Bun'));
      if (isNodeSpawnSync) {
        let options: ts.Expression | undefined = node.arguments[2];
        if (options && ts.isIdentifier(options)) options = resolveOptionsBinding(options.text, node);
        if (!options || !ts.isObjectLiteralExpression(options) || !optionsAreGuarded(options)) {
          lines.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return lines;
}

const unguardedSpawnSyncLines = (file: string): number[] =>
  unguardedSpawnSyncLinesInText(file, readFileSync(resolve(ROOT, file), 'utf8'));

test('harness · Pod · gate spawnSync readers specify maxBuffer (ratchet · allowlist only shrinks)', () => {
  const files = execFileSync('rg', ['-l', '\\bspawnSync\\b', ...MAX_BUFFER_SCOPE,
    '-g', '*.{ts,tsx,mts,cts,js,mjs,cjs}', '-g', '!*.test.ts', '-g', '!**/fixtures/**'],
  { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).trim().split('\n').filter(Boolean).sort();
  expect(files.length).toBeGreaterThan(20);
  const unguarded: Record<string, number> = {};
  const violations: string[] = [];
  for (const file of files) {
    const lines = unguardedSpawnSyncLines(file);
    if (lines.length === 0) continue;
    unguarded[file] = lines.length;
    if (DEFERRED_UNGUARDED[file]?.count !== lines.length) violations.push(`${file}:${lines.join(',')}`);
  }
  expect(violations).toEqual([]);
  expect(Object.keys(unguarded).sort()).toEqual(Object.keys(DEFERRED_UNGUARDED).sort());
});

test('ratchet detector flags a bare spawnSync reader and accepts maxBuffer / non-piped stdout', () => {
  const sample = (text: string) => {
    const source = ts.createSourceFile('sample.ts', text, ts.ScriptTarget.Latest, true);
    let options: ts.ObjectLiteralExpression | undefined;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.arguments[2] && ts.isObjectLiteralExpression(node.arguments[2])) options = node.arguments[2];
      ts.forEachChild(node, visit);
    };
    visit(source);
    return options ? optionsAreGuarded(options) : false;
  };
  expect(sample(`spawnSync('git', ['ls-files'], { encoding: 'utf8' });`)).toBe(false);
  expect(sample(`spawnSync('git', ['ls-files'], { encoding: 'utf8', maxBuffer: SPAWN_SYNC_MAX_BUFFER });`)).toBe(true);
  expect(sample(`spawnSync('git', ['fetch'], { stdio: 'inherit' });`)).toBe(true);
  expect(sample(`spawnSync('git', ['fetch'], { stdio: ['ignore', 'ignore', 'pipe'] });`)).toBe(true);
  expect(sample(`spawnSync('git', ['fetch'], { stdio: ['ignore', 'pipe', 'pipe'] });`)).toBe(false);
  expect(SPAWN_SYNC_MAX_BUFFER).toBe(16 * 1024 * 1024);
});

test('ratchet detector resolves an options identifier by its scope, not by name file-wide', () => {
  const shadowed = [
    "function guarded() { const options = { encoding: 'utf8', maxBuffer: SPAWN_SYNC_MAX_BUFFER }; return spawnSync('git', ['status'], options); }",
    "function bare() { const options = { encoding: 'utf8' }; return spawnSync('git', ['ls-files'], options); }",
  ].join('\n');
  expect(unguardedSpawnSyncLinesInText('sample.ts', shadowed)).toEqual([2]);
  const parameter = [
    "const options = { maxBuffer: SPAWN_SYNC_MAX_BUFFER };",
    "function run(options: object) { return spawnSync('git', ['ls-files'], options); }",
  ].join('\n');
  expect(unguardedSpawnSyncLinesInText('sample.ts', parameter)).toEqual([2]);
  const outer = [
    "const options = { encoding: 'utf8', maxBuffer: SPAWN_SYNC_MAX_BUFFER };",
    "function run() { return spawnSync('git', ['ls-files'], options); }",
  ].join('\n');
  expect(unguardedSpawnSyncLinesInText('sample.ts', outer)).toEqual([]);
  expect(unguardedSpawnSyncLinesInText('sample.ts', "Bun.spawnSync(['git', 'ls-files']);")).toEqual([]);
});

test('ratchet detector follows `import { spawnSync as X }` aliases', () => {
  const aliased = [
    "import { spawnSync as runSync } from 'node:child_process';",
    "runSync('git', ['ls-files'], { encoding: 'utf8' });",
    "runSync('git', ['ls-files'], { encoding: 'utf8', maxBuffer: SPAWN_SYNC_MAX_BUFFER });",
  ].join('\n');
  expect(unguardedSpawnSyncLinesInText('sample.ts', aliased)).toEqual([2]);
});

test('ratchet detector treats loop · parameter · catch bindings as the nearest scope (non-literal value = unknown = unguarded)', () => {
  const loop = [
    "const options = { encoding: 'utf8', maxBuffer: SPAWN_SYNC_MAX_BUFFER };",
    "for (const options of [{ encoding: 'utf8' }]) spawnSync('git', ['ls-files'], options);",
    "for (const options in {}) spawnSync('git', ['ls-files'], options);",
    "for (let options = { maxBuffer: SPAWN_SYNC_MAX_BUFFER }; false;) spawnSync('git', ['ls-files'], options);",
    "try { /* */ } catch (options) { spawnSync('git', ['ls-files'], options); }",
    "function run({ options }: { options: object }) { return spawnSync('git', ['ls-files'], options); }",
    "function ok() { return spawnSync('git', ['ls-files'], options); }",
  ].join('\n');
  expect(unguardedSpawnSyncLinesInText('sample.ts', loop)).toEqual([2, 3, 5, 6]);
});
