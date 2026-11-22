import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// This is a syntax-level ratchet, not a proof of runtime reachability or safety.
// Scan all production TS/JS in the two RunShell implementation directories and
// shell*/run-shell* tools, including new files whether or not imported yet. The
// gateway alone may import child_process values; its exact execution seam is
// checked separately. Type-only imports are harmless. External helpers outside
// these directories, dynamic/computed module names, reflection, native code,
// indirect dependency injection, shadowed globals, and PTY paths are not proven.
// Static references to child_process in scope are rejected conservatively, even
// if unreachable; this makes aliases, re-exports and literal require/import fail.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const gateway = 'src/shell-primitive/spawn-gateway.ts';
const processModules = new Set(['child_process', 'node:child_process']);
const bunMethods = new Set(['spawn', 'spawnSync']);

function propertyName(node: ts.Expression): string | undefined {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && node.argumentExpression && ts.isStringLiteral(node.argumentExpression)) return node.argumentExpression.text;
}

function violations(text: string, filename: string): string[] {
  const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true, filename.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const errors: string[] = [];
  const add = (node: ts.Node, why: string) => errors.push(`${filename}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: ${why}`);
  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const spec = node.moduleSpecifier.text;
      if (processModules.has(spec) && (!clause || (!clause.isTypeOnly && (clause.name || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings) || clause.namedBindings.elements.some(e => !e.isTypeOnly))))) add(node, 'child_process value import');
      if ((spec === 'bun' || spec === 'bun:ffi') && clause && !clause.isTypeOnly && (clause.name || (clause.namedBindings && (ts.isNamespaceImport(clause.namedBindings) || clause.namedBindings.elements.some(e => !e.isTypeOnly && bunMethods.has((e.propertyName ?? e.name).text)))))) add(node, 'Bun process import');
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && processModules.has(node.moduleSpecifier.text) && !node.isTypeOnly) add(node, 'child_process re-export');
    if (ts.isCallExpression(node) && node.arguments.length && ts.isStringLiteral(node.arguments[0]!) && processModules.has(node.arguments[0]!.text) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) add(node, 'child_process require/import');
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && ts.isIdentifier(node.expression) && node.expression.text === 'Bun' && bunMethods.has(propertyName(node) ?? '')) add(node, 'Bun process API');
    ts.forEachChild(node, visit);
  }
  visit(source);
  return errors;
}

function productionFiles(dir: string, base = root): string[] {
  return readdirSync(join(base, dir), { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return productionFiles(path, base);
    return /\.[cm]?[jt]sx?$/.test(entry.name) && !/(?:\.test|\.spec|\.d)\.[cm]?[jt]sx?$/.test(entry.name) ? [path] : [];
  });
}

function gatewayShape(text: string): string[] {
  const sf = ts.createSourceFile(gateway, text, ts.ScriptTarget.Latest, true);
  const imports = sf.statements.filter(ts.isImportDeclaration);
  const functions = sf.statements.filter(ts.isFunctionDeclaration);
  const imp = imports[0];
  const fn = functions[0];
  const bindings = imp?.importClause?.namedBindings;
  const values = bindings && ts.isNamedImports(bindings) ? bindings.elements.filter(e => !e.isTypeOnly).map(e => `${e.propertyName?.text ?? e.name.text}:${e.name.text}`) : [];
  const call = fn?.body?.statements[0];
  const expression = call && ts.isReturnStatement(call) ? call.expression : undefined;
  const ok = imports.length === 1 && ts.isStringLiteral(imp!.moduleSpecifier) && imp!.moduleSpecifier.text === 'node:child_process'
    && values.join(',') === 'spawn:spawn' && functions.length === 1 && fn?.name?.text === 'spawnGateway'
    && fn.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) && fn.parameters.length === 4
    && fn.parameters[3]?.name.getText(sf) === 'spawnFn' && fn.parameters[3]?.initializer?.getText(sf) === 'spawn'
    && fn.body?.statements.length === 1 && expression && ts.isCallExpression(expression)
    && expression.expression.getText(sf) === 'spawnFn' && expression.arguments.map(a => a.getText(sf)).join(',') === 'command,args,options'
    && sf.statements.every(s => ts.isImportDeclaration(s) || ts.isTypeAliasDeclaration(s) || ts.isFunctionDeclaration(s));
  return ok ? [] : ['gateway seam changed: review its sole spawn call and update this ratchet'];
}

function scopedFiles(base = root): string[] {
  const tools = productionFiles('src/skills/tools', base).filter(p => /^(?:shell|run-shell)/.test(basename(p)) || /^(?:shell|run-shell)/.test(p.slice('src/skills/tools/'.length)));
  return [...productionFiles('src/shell-primitive', base), ...productionFiles('src/shell-runner', base), ...tools];
}
function scan(base: string): string[] {
  return scopedFiles(base).flatMap(p => p === gateway ? gatewayShape(readFileSync(join(base, p), 'utf8')) : violations(readFileSync(join(base, p), 'utf8'), p));
}

describe('RunShell AST process boundary', () => {
  test('scoped production modules cannot acquire process APIs outside the single gateway', () => {
    const paths = scopedFiles();
    expect(paths).toContain(gateway);
    const failures = scan(root);
    expect(failures).toEqual([]);
  });

  test('negative fixtures: a new scoped file cannot hide process creation by syntax', () => {
    for (const code of [
      `import {spawn as launch} from 'node:child_process'; launch('x')`,
      `import * as cp from 'child_process'; cp.exec('x')`,
      `import cp from 'node:child_process'; cp['spawnSync']('x')`,
      `const {fork: f} = require('child_process'); f('x')`,
      `const cp = await import('node:child_process'); cp.spawn('x')`,
      `export {execFile as launch} from 'node:child_process'`,
      `Bun.spawn(['x']);`, `Bun['spawnSync'](['x']);`,
      `import {spawn as launch} from 'bun'; launch(['x']);`,
    ]) expect(violations(code, 'src/shell-runner/new-file.ts').length).toBeGreaterThan(0);
  });

  test.each([
    'src/shell-primitive/new.ts',
    'src/shell-runner/new.ts',
    'src/skills/tools/shell-new.ts',
    'src/skills/tools/run-shell-new.ts',
    'src/skills/tools/other/shell-worker.ts',
    'src/skills/tools/other/nested/run-shell-worker.ts',
    'src/skills/tools/shell-extra/worker.ts',
    'src/skills/tools/run-shell-extra/nested/worker.ts',
  ])('discovers and scans actual new file %s', file => {
    const base = mkdtempSync(join(tmpdir(), 'gateway-scan-'));
    try {
      for (const dir of ['src/shell-primitive', 'src/shell-runner', 'src/skills/tools']) mkdirSync(join(base, dir), {recursive: true});
      mkdirSync(dirname(join(base, file)), {recursive: true});
      writeFileSync(join(base, file), "import {spawn} from 'node:child_process'; spawn('x');");
      expect(scopedFiles(base)).toContain(file);
      expect(scan(base).some(error => error.includes(file))).toBe(true);
    } finally { rmSync(base, {recursive: true, force: true}); }
  });

  test('type-only imports and comments do not count as process creation', () => {
    expect(violations(`import type {ChildProcess} from 'node:child_process';\nimport {type SpawnOptions} from 'child_process';\n// Bun.spawn(['x'])\nconst description = "spawn";`, 'src/shell-runner/safe.ts')).toEqual([]);
  });

  test('gateway rejects a second process seam', () => {
    const good = readFileSync(join(root, gateway), 'utf8');
    expect(gatewayShape(good)).toEqual([]);
    expect(gatewayShape(good + `\nexport function bypass() { return Bun.spawn(['x']); }`)).not.toEqual([]);
    expect(gatewayShape(good.replace('return spawnFn(command, args, options);', `spawn('x'); return spawnFn(command, args, options);`))).not.toEqual([]);
  });
});
