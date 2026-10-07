#!/usr/bin/env bun
/** DOC-GEN — src/cli/ 의 정적 Commander 명령을 실행 없이 TypeScript AST 로 읽는다. */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { readCommit } from './generate-graph-anatomy.js';

export interface RenderCliAnatomyInput {
  readonly cliRoot: string;
  readonly repoRoot: string;
  readonly commit: string;
  readonly generatedAt: string;
}

interface CommandRow {
  readonly name: string;
  readonly description: string;
  readonly file: string;
}

function propertyCall(expression: ts.Expression, method: string): expression is ts.CallExpression & { expression: ts.PropertyAccessExpression } {
  return ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression)
    && expression.expression.name.text === method;
}

function literal(expression: ts.Expression | undefined): string | undefined {
  return expression && (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression))
    ? expression.text : undefined;
}

function descriptionOf(command: ts.CallExpression): string {
  let current: ts.Expression = command;
  while (ts.isPropertyAccessExpression(current.parent) && current.parent.expression === current
    && ts.isCallExpression(current.parent.parent) && current.parent.parent.expression === current.parent) {
    const property = current.parent;
    const call = current.parent.parent;
    if (property.name.text === 'description') return literal(call.arguments[0]) ?? '';
    if (property.name.text === 'command') break;
    current = call;
  }
  return '';
}

function rowsInFile(source: string, file: string): CommandRow[] {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  interface Scope {
    readonly owner: ts.Node;
    readonly parent?: Scope;
    readonly bindings: Map<string, ts.VariableDeclaration | null>;
  }
  const scopes = new Map<ts.Node, Scope>();
  const gather = (node: ts.Node, outer?: Scope): void => {
    const createsScope = ts.isSourceFile(node) || ts.isBlock(node) || ts.isModuleBlock(node)
      || ts.isCaseBlock(node) || ts.isCatchClause(node) || ts.isFunctionLike(node)
      || ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node);
    const scope: Scope = createsScope ? { owner: node, parent: outer, bindings: new Map() } : outer!;
    scopes.set(node, scope);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const list = node.parent;
      const isVar = ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.BlockScoped) === 0;
      let target = scope;
      if (isVar) {
        while (target.parent && !ts.isSourceFile(target.owner) && !ts.isFunctionLike(target.owner)) {
          target = target.parent;
        }
      }
      target.bindings.set(node.name.text, node);
    }
    if (ts.isFunctionLike(node)) {
      for (const parameter of node.parameters) {
        if (ts.isIdentifier(parameter.name)) scope.bindings.set(parameter.name.text, null);
      }
    }
    if (ts.isCatchClause(node) && node.variableDeclaration && ts.isIdentifier(node.variableDeclaration.name)) {
      scope.bindings.set(node.variableDeclaration.name.text, null);
    }
    ts.forEachChild(node, (child) => gather(child, scope));
  };
  gather(ast);

  const commandName = (expression: ts.Expression, seen: ReadonlySet<ts.VariableDeclaration> = new Set()): string => {
    if (ts.isParenthesizedExpression(expression)) return commandName(expression.expression, seen);
    if (ts.isIdentifier(expression)) {
      let scope = scopes.get(expression);
      while (scope && !scope.bindings.has(expression.text)) scope = scope.parent;
      const declaration = scope?.bindings.get(expression.text);
      if (!declaration || !declaration.initializer || seen.has(declaration)) return '';
      return commandName(declaration.initializer, new Set([...seen, declaration]));
    }
    if (propertyCall(expression, 'command')) {
      const name = literal(expression.arguments[0]);
      if (name === undefined) return '';
      const parent = commandName(expression.expression.expression, seen);
      return parent ? `${parent} ${name}` : name;
    }
    if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression)) {
      return commandName(expression.expression.expression, seen);
    }
    return '';
  };

  const rows: CommandRow[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && propertyCall(node, 'command')) {
      const name = literal(node.arguments[0]);
      if (name !== undefined) rows.push({ name: commandName(node), description: descriptionOf(node), file });
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return rows;
}

function cell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** 지정된 src/cli/ 바로 아래 .ts 만 읽으며 import/명령을 실행하지 않는다. */
export function renderCliAnatomy(input: RenderCliAnatomyInput): string {
  const rows = readdirSync(input.cliRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts')
      && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.spec.ts'))
    .flatMap((entry) => {
      const abs = join(input.cliRoot, entry.name);
      return rowsInFile(readFileSync(abs, 'utf8'), relative(input.repoRoot, abs).replace(/\\/g, '/'));
    })
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
  return [
    '# CLI anatomy',
    '',
    '> 이 문서는 생성물이다 — 손으로 고치지 마라',
    '',
    `- generatedAt: ${input.generatedAt}`,
    `- commit: ${input.commit}`,
    '',
    '| 명령 | 설명 | 정의 파일 |',
    '| --- | --- | --- |',
    ...rows.map((row) => `| ${cell(row.name)} | ${cell(row.description)} | ${cell(row.file)} |`),
    '',
  ].join('\n');
}

export function defaultOutputPath(repoRoot: string): string {
  return join(repoRoot, 'docs', 'generated', 'cli-anatomy.md');
}

function main(): void {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const argv = process.argv.slice(2);
  const index = argv.indexOf('--out');
  const outArg = index < 0 ? undefined : argv[index + 1];
  if (index >= 0 && (!outArg || outArg.startsWith('--'))) throw new Error('--out 에는 경로가 필요하다');
  const out = outArg ?? defaultOutputPath(repoRoot);
  const markdown = renderCliAnatomy({ cliRoot: join(repoRoot, 'src', 'cli'), repoRoot,
    commit: readCommit(repoRoot), generatedAt: new Date().toISOString() });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, markdown);
  process.stdout.write(`${out}\n`);
}

if (import.meta.main) main();
