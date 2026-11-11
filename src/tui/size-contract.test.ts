import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { measureRuntimeStaticClosure, runtimeStaticSpecifiers } from '../../scripts/lib/tui-runtime-static-closure.js';

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'] as const;

type GitOutput = (args: string[]) => string;

function readBaseDashboardEntry(runGit: GitOutput = (args) => execFileSync('git', args, { encoding: 'utf8' })): string {
  const base = runGit(['merge-base', 'HEAD', 'origin/main']).trim();
  if (!base) throw new Error('merge-base HEAD origin/main returned no base');
  const source = runGit(['show', `${base}:src/dashboard/index.ts`]);
  if (!source) throw new Error(`origin/main merge-base dashboard source is missing: ${base}`);
  return source;
}

function sourceFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension))
        && !path.endsWith('.test.ts') && !path.endsWith('.test.tsx')
        && !path.endsWith('.test.mts') && !path.endsWith('.test.cts')) files.push(path);
    }
  };
  visit(root);
  return files;
}

function hasBranchDependency(source: string, filePath = join(import.meta.dir, 'core', 'probe.ts')): boolean {
  const file = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);
  const branchRoot = resolve(import.meta.dir, 'branches');
  let found = false;
  const pointsIntoBranches = (specifier: string): boolean => {
    const resolvedModule = ts.resolveModuleName(specifier, filePath, {
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      allowImportingTsExtensions: true,
    }, ts.sys).resolvedModule?.resolvedFileName;
    const normalized = resolvedModule ?? resolve(dirname(filePath), specifier.replace(/\.(?:mjs|cjs|js)$/, ''));
    const fromBranches = relative(branchRoot, normalized);
    return fromBranches === '' || (!isAbsolute(fromBranches) && fromBranches !== '..' && !fromBranches.startsWith(`..${sep}`));
  };
  const walk = (node: ts.Node): void => {
    const specifier = (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text
      : ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
        && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]) ? node.arguments[0].text
        : undefined;
    if (specifier && pointsIntoBranches(specifier)) found = true;
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression && ts.isStringLiteral(node.moduleReference.expression)
      && pointsIntoBranches(node.moduleReference.expression.text)) found = true;
    ts.forEachChild(node, walk);
  };
  walk(file);
  return found;
}

function branchGateViolations(sources: readonly { path: string; source: string }[]): string[] {
  const violations: string[] = [];
  const gateFiles = new Map<string, Set<string>>();
  for (const { path, source } of sources) {
    if (/process\.env|readUserConfig|loadUserConfig|safeParse|isEnabled\(|featureFlag/.test(source)) {
      violations.push(`${path}: branch-level config, flag, or schema gate`);
    }
    const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    const walk = (node: ts.Node): void => {
      let condition: ts.Expression | undefined;
      if (ts.isIfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)) condition = node.expression;
      else if (ts.isForStatement(node)) condition = node.condition;
      else if (ts.isConditionalExpression(node)) condition = node.condition;
      if (condition) {
        for (const key of configGateKeys(condition, true)) {
          const paths = gateFiles.get(key) ?? new Set<string>();
          paths.add(path);
          gateFiles.set(key, paths);
        }
      }
      if (ts.isBinaryExpression(node)
        && (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
          || node.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
        for (const key of configGateKeys(node, false)) {
          const paths = gateFiles.get(key) ?? new Set<string>();
          paths.add(path);
          gateFiles.set(key, paths);
        }
      }
      ts.forEachChild(node, walk);
    };
    walk(file);
  }
  for (const [expression, paths] of gateFiles) {
    if (paths.size > 1) violations.push(`duplicated gate (${expression}): ${[...paths].sort().join(', ')}`);
  }
  return violations.sort();
}

function configGateKeys(node: ts.Node, includeLogicalResults: boolean): string[] {
  const keys = new Set<string>();
  const chain = (expression: ts.Expression): string | undefined => {
    if (ts.isIdentifier(expression)) return expression.text;
    if (ts.isPropertyAccessExpression(expression)) {
      const parent = chain(expression.expression);
      return parent ? `${parent}.${expression.name.text}` : undefined;
    }
    if (ts.isElementAccessExpression(expression) && expression.argumentExpression
      && ts.isStringLiteral(expression.argumentExpression)) {
      const parent = chain(expression.expression);
      return parent ? `${parent}.${expression.argumentExpression.text}` : undefined;
    }
    return undefined;
  };
  const walk = (current: ts.Node): void => {
    if (ts.isCallExpression(current)) {
      if (ts.isIdentifier(current.expression)
        && /^(?:Boolean|Number|String|parseInt|parseFloat)$/.test(current.expression.text)) {
        for (const argument of current.arguments) walk(argument);
      }
      return;
    }
    if (ts.isBinaryExpression(current)
      && current.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      walk(current.right);
      return;
    }
    if (ts.isBinaryExpression(current)
      && (current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
        || current.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
      walk(current.left);
      if (includeLogicalResults) walk(current.right);
      return;
    }
    if (ts.isNewExpression(current)) return;
    if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      const parentExtendsAccess = (ts.isPropertyAccessExpression(current.parent)
        || ts.isElementAccessExpression(current.parent)) && current.parent.expression === current;
      const value = chain(current);
      if (!parentExtendsAccess && value
        && /^(?:config|flags?|featureFlags?|features?|capabilities|permissions|maturity|audience)(?:\.|$)/i.test(value)) keys.add(value);
    }
    if (ts.isIdentifier(current) && /^(?:flag|featureFlag|isEnabled)$/i.test(current.text)) keys.add(current.text);
    ts.forEachChild(current, walk);
  };
  walk(node);
  return [...keys];
}

test('every src/tui TypeScript file stays below the 4,000 line limit', () => {
  const root = import.meta.dir;
  const files: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(path);
    }
  };
  visit(root);
  const oversized = files.filter((path) => readFileSync(path, 'utf8').split('\n').length > 4_000);
  expect(oversized).toEqual([]);
});

test('classic dashboard entry stays below its merge-base size and post-diet ceiling', () => {
  const dashboardEntry = readFileSync(join(import.meta.dir, '../dashboard/index.ts'), 'utf8');
  const lineCount = dashboardEntry.split('\n').length - (dashboardEntry.endsWith('\n') ? 1 : 0);
  const baseDashboardEntry = readBaseDashboardEntry();
  const baseLineCount = baseDashboardEntry.split('\n').length - (baseDashboardEntry.endsWith('\n') ? 1 : 0);
  expect(lineCount).toBeLessThanOrEqual(baseLineCount);
  expect(lineCount).toBeLessThanOrEqual(19_686);
});

test('classic dashboard size guard fails closed when origin/main has no merge-base', () => {
  expect(() => readBaseDashboardEntry((args) => args[0] === 'merge-base' ? '' : 'unreachable'))
    .toThrow('merge-base HEAD origin/main returned no base');
});

test('next entry imports no dashboard module and legacy imports do not grow', () => {
  const root = import.meta.dir;
  const files: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) files.push(path);
    }
  };
  visit(root);
  const dashboardImports = files.flatMap((path) => {
    const source = readFileSync(path, 'utf8');
    return [...source.matchAll(/(?:from\s*|import\s*\()['"]([^'"]*dashboard\/[^'"]+)['"]/g)]
      .map((match) => `${path.slice(root.length + 1)}:${match[1]}`);
  }).sort();
  // Source: 내부 문서 `next-tui-production` §4 item 33; picker modules have no dashboard import.
  expect(dashboardImports).toEqual([]);
  const classicTerm = readFileSync(join(root, 'slash/term.ts'), 'utf8');
  // Source: 내부 문서 `next-tui-production` sets the per-module 600-line limit.
  expect(classicTerm.split('\n').length - 1).toBeLessThanOrEqual(600);
  expect(classicTerm).not.toMatch(/(?:from\s*|import\s*\()['"][^'"]*dashboard\//);
  for (const path of ['entry.ts', 'input/composer.ts', 'chat/log-view.ts']) {
    expect(readFileSync(join(root, path), 'utf8')).not.toMatch(/(?:from\s*|import\s*\()['"][^'"]*dashboard\//);
  }
});

test('next TUI entry stays within the design budget (100 runtime-static files / 25k lines)', () => {
  const measured = measureRuntimeStaticClosure(join(import.meta.dir, 'entry.ts'));
  const baseline = JSON.parse(readFileSync(join(import.meta.dir, 'size-contract.ratchet.json'), 'utf8')) as {
    runtimeStaticFiles: number; runtimeStaticLines: number;
  };
  if (measured.files > baseline.runtimeStaticFiles || measured.lines > baseline.runtimeStaticLines) {
    console.warn(`TUI closure ratchet grew: ${baseline.runtimeStaticFiles}/${baseline.runtimeStaticLines} → ${measured.files}/${measured.lines}; regenerate with bun run scripts/update-tui-size-ratchet.ts`);
  }
  expect(measured.files).toBeLessThanOrEqual(100);
  expect(measured.lines).toBeLessThanOrEqual(25_000);
}, 30_000);

test('new next TUI production modules stay within 600 lines', () => {
  const root = import.meta.dir;
  const existingOversized = new Set(['entry.ts', 'slash/term.ts', 'input/pickers.ts']);
  const oversized: string[] = [];
  for (const path of sourceFiles(root)) {
    if (readFileSync(path, 'utf8').split('\n').length > 600) {
      const relative = path.slice(root.length + 1);
      if (!existingOversized.has(relative)) oversized.push(relative);
    }
  }
  expect(oversized).toEqual([]);
});

test('CORE has no eager or literal-dynamic dependency on optional branches', () => {
  const core = join(import.meta.dir, 'core');
  const violations: string[] = [];
  for (const path of sourceFiles(core)) {
    if (hasBranchDependency(readFileSync(path, 'utf8'), path)) violations.push(path);
  }
  expect(violations).toEqual([]);
});

test('optional branches do not repeat config, feature-flag, or runtime-schema gates', () => {
  const root = join(import.meta.dir, 'branches');
  const violations = branchGateViolations(sourceFiles(root).map((path) => ({ path, source: readFileSync(path, 'utf8') })));
  expect(violations).toEqual([]);
});

test('CORE dependency guard catches side-effect and directory-entry imports', () => {
  expect(hasBranchDependency("import '../branches/app.js';")).toBe(true);
  expect(hasBranchDependency("import '../branches';")).toBe(true);
  expect(hasBranchDependency("export * from '../branches/app.js';")).toBe(true);
  expect(hasBranchDependency("const branch = await import('../branches/app.js');")).toBe(true);
  expect(hasBranchDependency("import branch = require('../branches/app.js');")).toBe(true);
  expect(hasBranchDependency("import '../../branches/app.js';", join(import.meta.dir, 'core', 'nested', 'probe.ts'))).toBe(true);
  expect(hasBranchDependency("import { run } from './core-turn.js';")).toBe(false);
});

test('runtime-static closure keeps mixed default imports and ignores type-only edges', () => {
  expect(runtimeStaticSpecifiers("import value, { type T } from './runtime.js'; import type { U } from './types.js';"))
    .toEqual(['./runtime.js']);
  expect(runtimeStaticSpecifiers("export type { T } from './types.js'; export { value } from './runtime.js';"))
    .toEqual(['./runtime.js']);
});

test('branch gate detector allows distinct gates and rejects repeated or branch-local gates', () => {
  expect(branchGateViolations([
    { path: 'a.ts', source: 'if (ready) runA();' },
    { path: 'b.ts', source: 'if (available) runB();' },
  ])).toEqual([]);
  expect(branchGateViolations([
    { path: 'a.ts', source: 'if (config.enabled) runA();' },
    { path: 'b.ts', source: 'if (config.enabled && runB()) runB();' },
  ])).toEqual(['duplicated gate (config.enabled): a.ts, b.ts']);
  expect(branchGateViolations([
    { path: 'a.ts', source: 'if (config.enabled) runA();' },
    { path: 'b.ts', source: 'const result = config.enabled ? runB() : undefined;' },
  ])).toEqual(['duplicated gate (config.enabled): a.ts, b.ts']);
  expect(branchGateViolations([
    { path: 'a.ts', source: 'if (!result) return;' },
    { path: 'b.ts', source: 'if (!result) return;' },
  ])).toEqual([]);
  expect(branchGateViolations([
    { path: 'a.ts', source: 'config.enabled && runA();' },
    { path: 'b.ts', source: 'config.enabled && runB();' },
  ])).toEqual(['duplicated gate (config.enabled): a.ts, b.ts']);
  expect(branchGateViolations([
    { path: 'a.ts', source: 'if (config.ui.alpha) runA();' },
    { path: 'b.ts', source: 'if (config.ui.beta) runB();' },
  ])).toEqual([]);
  expect(branchGateViolations([
    { path: 'a.ts', source: 'ready && run(config.ui.alpha);' },
    { path: 'b.ts', source: 'available && run(config.ui.alpha);' },
  ])).toEqual([]);
  expect(branchGateViolations([
    { path: 'a.ts', source: 'const x = ready && config.ui.alpha;' },
    { path: 'b.ts', source: 'const x = available && config.ui.alpha;' },
  ])).toEqual([]);
  expect(branchGateViolations([
    { path: 'a.ts', source: 'if (Boolean(config.enabled)) runA();' },
    { path: 'b.ts', source: 'if (Boolean(config.enabled)) runB();' },
  ])).toEqual(['duplicated gate (config.enabled): a.ts, b.ts']);
  expect(branchGateViolations([
    { path: 'a.ts', source: 'if (Number(config.enabled)) runA();' },
    { path: 'b.ts', source: 'if (Number(config.enabled)) runB();' },
  ])).toEqual(['duplicated gate (config.enabled): a.ts, b.ts']);
  expect(branchGateViolations([
    { path: 'a.ts', source: 'if (Boolean(config.enabled), ready) runA();' },
    { path: 'b.ts', source: 'if (Boolean(config.enabled), available) runB();' },
  ])).toEqual([]);
  expect(branchGateViolations([
    { path: 'a.ts', source: 'if (ready && config.ui.alpha) runA();' },
    { path: 'b.ts', source: 'if (available && config.ui.alpha) runB();' },
  ])).toEqual(['duplicated gate (config.ui.alpha): a.ts, b.ts']);
  expect(branchGateViolations([
    { path: 'a.ts', source: "const enabled = process.env.FEATURE === '1';" },
  ])).toEqual(['a.ts: branch-level config, flag, or schema gate']);
});
