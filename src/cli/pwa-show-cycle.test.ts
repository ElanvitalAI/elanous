import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';

const modules = [
  'cli/pwa-show.ts',
  'cli/nexus-show.ts',
  'nexus/daemon-endpoint.ts',
  'nexus/pwa-resolution.ts',
].map((file) => resolve(import.meta.dir, '..', file));

function runtimeDependencies(filePath: string): string[] {
  const source = ts.createSourceFile(filePath, readFileSync(filePath, 'utf8'), ts.ScriptTarget.Latest, true);
  const dependencies: string[] = [];
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const clause = statement.importClause;
      const runtimeBinding = !clause?.isTypeOnly && (clause === undefined || clause.name !== undefined
        || (clause.namedBindings && (ts.isNamespaceImport(clause.namedBindings)
          || clause.namedBindings.elements.some((element) => !element.isTypeOnly))));
      if (!runtimeBinding || !statement.moduleSpecifier.text.startsWith('.')) continue;
      const resolved = resolve(dirname(filePath), statement.moduleSpecifier.text.replace(/\.js$/, '.ts'));
      if (modules.includes(resolved as typeof modules[number])) dependencies.push(resolved);
    }
    if (ts.isExportDeclaration(statement) && !statement.isTypeOnly && statement.moduleSpecifier
      && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text.startsWith('.')) {
      const resolved = resolve(dirname(filePath), statement.moduleSpecifier.text.replace(/\.js$/, '.ts'));
      if (modules.includes(resolved as typeof modules[number])) dependencies.push(resolved);
    }
  }
  return dependencies;
}

function hasRuntimeCycle(graph: ReadonlyMap<string, readonly string[]>): boolean {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (file: string): boolean => {
    if (visiting.has(file)) return true;
    if (visited.has(file)) return false;
    visiting.add(file);
    for (const dependency of graph.get(file) ?? []) if (visit(dependency)) return true;
    visiting.delete(file);
    visited.add(file);
    return false;
  };
  return modules.some(visit);
}

test('PWA/Nexus show runtime imports stay acyclic', () => {
  const graph = new Map(modules.map((file) => [file, runtimeDependencies(file)]));
  expect(hasRuntimeCycle(graph)).toBe(false);
});
