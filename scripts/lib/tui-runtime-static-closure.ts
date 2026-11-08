import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import ts from 'typescript';

export function runtimeStaticSpecifiers(source: string): string[] {
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

function resolveRuntimeImport(from: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const base = join(dirname(from), specifier.replace(/\.(?:mjs|cjs|js)$/, ''));
  for (const candidate of [
    base, `${base}.ts`, `${base}.tsx`, `${base}.mts`, `${base}.cts`, `${base}.js`, `${base}.jsx`,
    join(base, 'index.ts'), join(base, 'index.tsx'), join(base, 'index.mts'), join(base, 'index.cts'),
    join(base, 'index.js'), join(base, 'index.jsx'),
  ]) {
    try {
      readFileSync(candidate);
      return candidate;
    } catch { /* try the next TypeScript resolution form */ }
  }
  return undefined;
}

export function measureRuntimeStaticClosure(entry: string): { files: number; lines: number } {
  const visited = new Set<string>();
  const visit = (path: string): void => {
    if (visited.has(path)) return;
    visited.add(path);
    for (const specifier of runtimeStaticSpecifiers(readFileSync(path, 'utf8'))) {
      const dependency = resolveRuntimeImport(path, specifier);
      if (dependency) visit(dependency);
    }
  };
  visit(entry);
  const lines = [...visited].reduce((sum, path) => sum + readFileSync(path, 'utf8').split('\n').length, 0);
  return { files: visited.size, lines };
}
