import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'] as const;

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

function runtimeStaticSpecifiers(source: string): string[] {
  const file = ts.createSourceFile('module.ts', source, ts.ScriptTarget.Latest, true);
  const specifiers: string[] = [];
  const walk = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
      && !node.importClause?.isTypeOnly
      && !(node.importClause && !node.importClause.name && node.importClause.namedBindings
        && ts.isNamedImports(node.importClause.namedBindings)
        && node.importClause.namedBindings.elements.length > 0
        && node.importClause.namedBindings.elements.every((element) => element.isTypeOnly))) {
      specifiers.push(node.moduleSpecifier.text);
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
      && !node.isTypeOnly
      && !(node.exportClause && ts.isNamedExports(node.exportClause)
        && node.exportClause.elements.length > 0
        && node.exportClause.elements.every((element) => element.isTypeOnly))) {
      specifiers.push(node.moduleSpecifier.text);
    }
    ts.forEachChild(node, walk);
  };
  walk(file);
  return specifiers;
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
  // These are pre-existing legacy TUI references. The next entry's closure has none.
  expect(dashboardImports).toEqual([
    'input/pickers.ts:../../dashboard/finder-feedback-runtime.js',
    'input/pickers.ts:../../dashboard/modals/preview.js',
    'input/pickers.ts:../../dashboard/transfer-feedback-runtime.js',
    'slash/term.ts:../../dashboard/input/terminal-modal-router.js',
    'slash/term.ts:../../dashboard/slash-runtime/registry.js',
    'slash/term.ts:../../dashboard/term-slash-runtime.js',
  ]);
  for (const path of ['entry.ts', 'input/composer.ts', 'chat/log-view.ts']) {
    expect(readFileSync(join(root, path), 'utf8')).not.toMatch(/(?:from\s*|import\s*\()['"][^'"]*dashboard\//);
  }
});

test('next TUI entry stays within the audited runtime-static ceiling (goal: 100 files / 25k lines)', () => {
  const entry = join(import.meta.dir, 'entry.ts');
  const visited = new Set<string>();
  const resolve = (from: string, specifier: string): string | undefined => {
    if (!specifier.startsWith('.')) return undefined;
    const base = join(from, '..', specifier.replace(/\.(?:mjs|cjs|js)$/, ''));
    for (const candidate of [
      base, `${base}.ts`, `${base}.tsx`, `${base}.mts`, `${base}.cts`, `${base}.js`, `${base}.jsx`,
      join(base, 'index.ts'), join(base, 'index.tsx'), join(base, 'index.mts'), join(base, 'index.cts'),
      join(base, 'index.js'), join(base, 'index.jsx'),
    ]) {
      try {
        if (readFileSync(candidate).length >= 0) return candidate;
      } catch { /* try the next TypeScript resolution form */ }
    }
    return undefined;
  };
  const visit = (path: string): void => {
    if (visited.has(path)) return;
    visited.add(path);
    for (const specifier of runtimeStaticSpecifiers(readFileSync(path, 'utf8'))) {
      const dependency = resolve(path, specifier);
      if (dependency) visit(dependency);
    }
  };
  visit(entry);
  const lines = [...visited].reduce((sum, path) => sum + readFileSync(path, 'utf8').split('\n').length, 0);
  // 11-06 measured on origin/main 7c2a88c plus this closure check: 86 runtime-static files / 20,037 lines.
  // 11-07 0.3.6 cut: main 3b8d3b5a reaches 89 files (lines still under 20,037) — ceiling 89 pending the shrink cell TUI-ENTRY-SIZE-REGROW.
  expect(visited.size).toBeLessThanOrEqual(89);
  expect(lines).toBeLessThanOrEqual(20_037);
}, 30_000);

test('new next TUI production modules stay within 600 lines', () => {
  const root = import.meta.dir;
  const existingOversized = new Set(['entry.ts', 'slash/term.ts', 'sidetab/attach.ts', 'input/pickers.ts']);
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
