import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { dashboardSourceLocations, readDashboardSources, type DashboardSource } from './helpers/dashboard-source.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DASHBOARD_DIR = resolve(HERE, '..', 'src', 'dashboard');
const WIRING_EXPORT = /^(?:boot|register|wire|arm)\w*Dashboard\w*$/;
const DECLARATION_EXPORT = /export\s+(?:default\s+)?(?:async\s+)?(?:function|class)\s+(\w+)/g;
const VARIABLE_EXPORT = /export\s+(?:const|let|var)\s+([^;]+);/g;
const VARIABLE_DECLARATION = /(?:^|,)\s*(\w+)\s*(?::[^=,]+)?=/g;
const NAMED_EXPORT = /export\s*{([^}]+)}\s*(?:from\s*['"][^'"]+['"])?/g;
const EXPORT_STAR = /export\s*\*\s*from\s*['"]([^'"]+)['"]/g;

function modulePath(path: string, specifier: string): string {
  return resolve(dirname(path), extname(specifier) ? specifier.replace(/\.js$/, '.ts') : `${specifier}.ts`);
}

function namesFromSpecifiers(specifiers: string): string[] {
  return specifiers.split(',').map((specifier) => {
    const [original, alias] = specifier.trim().split(/\s+as\s+/);
    return alias ?? original;
  }).filter((name) => WIRING_EXPORT.test(name));
}

function exportedWiringNames(path: string, visited = new Set<string>()): string[] {
  if (visited.has(path)) return [];
  visited.add(path);

  const source = readFileSync(path, 'utf8');
  const names = new Set<string>();
  for (const match of source.matchAll(DECLARATION_EXPORT)) {
    if (WIRING_EXPORT.test(match[1])) names.add(match[1]);
  }
  for (const match of source.matchAll(VARIABLE_EXPORT)) {
    for (const declaration of match[1].matchAll(VARIABLE_DECLARATION)) {
      if (WIRING_EXPORT.test(declaration[1])) names.add(declaration[1]);
    }
  }
  for (const match of source.matchAll(NAMED_EXPORT)) {
    for (const name of namesFromSpecifiers(match[1])) names.add(name);
  }
  for (const match of source.matchAll(EXPORT_STAR)) {
    for (const name of exportedWiringNames(modulePath(path, match[1]), visited)) names.add(name);
  }
  return [...names];
}

// This counts call sites across the directory, not boot reachability (reserved for import-graph checks).
function missingWiringNames(names: readonly string[], sources: readonly DashboardSource[]): string[] {
  const calls = new Set<string>();
  for (const { path, text } of sources) {
    const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        // A function recursively calling itself does not prove any dashboard wiring.
        let owner: ts.Node | undefined = node.parent;
        while (owner && !ts.isFunctionDeclaration(owner)) owner = owner.parent;
        if (!owner || owner.name?.text !== node.expression.text) calls.add(node.expression.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return names.filter((name) => !calls.has(name));
}

const dashboardWiringNames = readDashboardSources(DASHBOARD_DIR)
  .flatMap(({ path }) => exportedWiringNames(resolve(HERE, '..', path)))
  .sort();

describe('dashboard wiring contract', () => {
  test('derives at least one dashboard wiring export from source modules', () => {
    expect(dashboardWiringNames).not.toHaveLength(0);
  });

  test('calls every derived dashboard wiring export from dashboard sources', () => {
    const sources = readDashboardSources();
    const missingNames = missingWiringNames(dashboardWiringNames, sources);

    expect(missingNames, `dashboard sources do not call: ${missingNames.join(', ')}; searched ${dashboardSourceLocations(sources)}`).toEqual([]);
  });

  test('derives named local exports and named re-exports, then identifies each missing call', () => {
    const fixtureDir = mkdtempSync(resolve(tmpdir(), 'dashboard-wiring-contract-'));
    try {
      const localPath = resolve(fixtureDir, 'local.ts');
      const reexportPath = resolve(fixtureDir, 'reexport.ts');
      const variablesPath = resolve(fixtureDir, 'variables.ts');
      writeFileSync(localPath, 'function bootDashboardLocal() {}\nexport { bootDashboardLocal };\n');
      writeFileSync(reexportPath, "export { wireDashboardRemote } from './remote.js';\n");
      writeFileSync(variablesPath, 'export const other = 1, bootDashboardSecond = () => {};\n');
      writeFileSync(resolve(fixtureDir, 'remote.ts'), 'export function wireDashboardRemote() {}\n');

      const names = [
        ...exportedWiringNames(localPath),
        ...exportedWiringNames(reexportPath),
        ...exportedWiringNames(variablesPath),
      ].sort();
      expect(names).toEqual(['bootDashboardLocal', 'bootDashboardSecond', 'wireDashboardRemote']);
      expect(missingWiringNames(names, [{ path: 'local.ts', text: 'bootDashboardLocal()\nbootDashboardSecond()' }])).toEqual(['wireDashboardRemote']);
      expect(missingWiringNames(names, [{ path: 'remote.ts', text: 'bootDashboardLocal()\nwireDashboardRemote()' }])).toEqual(['bootDashboardSecond']);
      expect(missingWiringNames(names, [{ path: 'remote.ts', text: 'export function wireDashboardRemote() {}' }])).toEqual(['bootDashboardLocal', 'bootDashboardSecond', 'wireDashboardRemote']);
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  test('does not credit a recursive self-call in an unused module as a wiring call', () => {
    const fixtureDir = mkdtempSync(resolve(tmpdir(), 'dashboard-wiring-self-call-'));
    try {
      const entry = resolve(fixtureDir, 'index.ts');
      const unused = resolve(fixtureDir, 'unused.ts');
      writeFileSync(entry, 'export {};\n');
      writeFileSync(unused, 'export function bootDashboardUnused() { bootDashboardUnused(); }\n');
      expect(missingWiringNames(exportedWiringNames(unused), readDashboardSources(fixtureDir))).toEqual(['bootDashboardUnused']);
      writeFileSync(entry, "import { bootDashboardUnused } from './unused.js';\nbootDashboardUnused();\n");
      expect(missingWiringNames(exportedWiringNames(unused), readDashboardSources(fixtureDir))).toEqual([]);
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});
