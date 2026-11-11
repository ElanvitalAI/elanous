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

test('classic dashboard has one named root launcher seam and no other production imports', () => {
  const edges = productionTypescriptFiles(sourceRoot).flatMap((path) => dashboardEdges(path, readFileSync(path, 'utf8')));
  expect(edges.sort()).toEqual(['src/index.ts dynamic ./dashboard/index.js']);
});

test('classic seam scan resolves directory imports and require calls into dashboard', () => {
  const path = resolve(sourceRoot, 'ux-sim/classic-bypass-example.ts');
  expect(dashboardEdges(path, "import { showDashboard } from '../dashboard';")).toEqual([
    'src/ux-sim/classic-bypass-example.ts static ../dashboard',
  ]);
  expect(dashboardEdges(path, "const dashboard = require('../dashboard/index.js');")).toEqual([
    'src/ux-sim/classic-bypass-example.ts require ../dashboard/index.js',
  ]);
});
