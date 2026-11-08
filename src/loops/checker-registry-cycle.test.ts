import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import ts from 'typescript';

const checker = resolve(import.meta.dir, 'checker.ts');
const registry = resolve(import.meta.dir, 'registry.ts');
const sourceExtensions = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']);

function localSourcePath(importer: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const base = resolve(dirname(importer), specifier);
  const candidates = [base];
  for (const extension of sourceExtensions) candidates.push(`${base}${extension}`);
  if (/\.(?:js|mjs|cjs)$/.test(base)) {
    const sourceBase = base.replace(/\.(?:js|mjs|cjs)$/, '');
    for (const extension of sourceExtensions) candidates.push(`${sourceBase}${extension}`);
  }
  for (const extension of sourceExtensions) candidates.push(resolve(base, `index${extension}`));
  return candidates.find((candidate) => sourceExtensions.has(extname(candidate)) && existsSync(candidate));
}

function runtimeDependencies(filePath: string, text = readFileSync(filePath, 'utf8')): string[] {
  const source = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true);
  const dependencies: string[] = [];
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const clause = statement.importClause;
      const runtimeBinding = !clause?.isTypeOnly && (clause === undefined || clause.name !== undefined
        || (clause.namedBindings && (ts.isNamespaceImport(clause.namedBindings)
          || clause.namedBindings.elements.some((element) => !element.isTypeOnly))));
      if (runtimeBinding) {
        const dependency = localSourcePath(filePath, statement.moduleSpecifier.text);
        if (dependency) dependencies.push(dependency);
      }
    }
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
      const runtimeBinding = !statement.isTypeOnly && (!statement.exportClause
        || ts.isNamespaceExport(statement.exportClause)
        || statement.exportClause.elements.some((element) => !element.isTypeOnly));
      if (runtimeBinding) {
        const dependency = localSourcePath(filePath, statement.moduleSpecifier.text);
        if (dependency) dependencies.push(dependency);
      }
    }
  }
  return dependencies;
}

function runtimeGraph(seeds: readonly string[]): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  const pending = [...seeds];
  while (pending.length) {
    const file = pending.pop()!;
    if (graph.has(file)) continue;
    const dependencies = runtimeDependencies(file);
    graph.set(file, dependencies);
    pending.push(...dependencies);
  }
  return graph;
}

function hasRuntimeCycle(graph: ReadonlyMap<string, readonly string[]>): boolean {
  const active = new Set<string>();
  const complete = new Set<string>();
  const visit = (file: string): boolean => {
    if (active.has(file)) return true;
    if (complete.has(file)) return false;
    active.add(file);
    for (const dependency of graph.get(file) ?? []) {
      if (visit(dependency)) return true;
    }
    active.delete(file);
    complete.add(file);
    return false;
  };
  for (const file of graph.keys()) if (visit(file)) return true;
  return false;
}

function hasCycleThrough(graph: ReadonlyMap<string, readonly string[]>, target: string): boolean {
  const reachesTarget = (file: string, visited = new Set<string>()): boolean => {
    if (file === target) return true;
    if (visited.has(file)) return false;
    visited.add(file);
    return (graph.get(file) ?? []).some((dependency) => reachesTarget(dependency, visited));
  };
  return (graph.get(target) ?? []).some((dependency) => reachesTarget(dependency));
}

test('loop checker and registry runtime imports stay acyclic through intermediate modules', () => {
  const graph = runtimeGraph([checker, registry]);
  expect(graph.get(checker)).toContain(registry);
  expect(hasCycleThrough(graph, checker)).toBe(false);
  expect(hasCycleThrough(graph, registry)).toBe(false);

  const fixtureRoot = resolve(import.meta.dir, 'fixtures/checker-registry-cycle/registry.js');
  const simulatedCycle = runtimeGraph([fixtureRoot]);
  expect(simulatedCycle.get(fixtureRoot)).toContain(resolve(import.meta.dir, 'fixtures/checker-registry-cycle/helper.js'));
  expect(hasRuntimeCycle(simulatedCycle)).toBe(true);

  const scheduleRoot = resolve(import.meta.dir, 'fixtures/checker-registry-cycle/schedule-checker.js');
  const scheduleCycle = runtimeGraph([scheduleRoot]);
  expect(hasRuntimeCycle(scheduleCycle)).toBe(true);
});
