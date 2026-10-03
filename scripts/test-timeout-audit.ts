import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

export type TimeoutStatus = '파일 기본' | '시험별 일부' | '없음';
export type TimeoutFinding = { file: string; spawnLines: number; timeout: TimeoutStatus };

const target = /\bbin\/elanous\.mjs\b|\bprocess\.execPath\b|["']bun["']|\bscripts\/[^\s"']+\.(?:ts|tsx|sh)\b/;
const processCalls = new Set(['spawnSync', 'Bun.spawnSync', 'Bun.spawn', 'execFileSync', 'execSync']);

function callName(node: ts.CallExpression): string {
  return node.expression.getText();
}

/** Inspect the command and argv, not unrelated options, resolving local const aliases. */
function commandText(node: ts.Expression, constants: ReadonlyMap<string, ts.Expression>, seen = new Set<string>()): string {
  if (ts.isIdentifier(node) && constants.has(node.text)) {
    if (seen.has(node.text)) return '';
    seen.add(node.text);
    return commandText(constants.get(node.text)!, constants, seen);
  }
  if (ts.isArrayLiteralExpression(node)) return node.elements.map((element) => commandText(element as ts.Expression, constants, new Set(seen))).join(' ');
  if (ts.isObjectLiteralExpression(node)) return node.properties.map((property) =>
    ts.isPropertyAssignment(property) ? commandText(property.initializer, constants, new Set(seen)) : '').join(' ');
  if (ts.isStringLiteralLike(node)) return JSON.stringify(node.text);
  if (ts.isPropertyAccessExpression(node) && node.getText() === 'process.execPath') return node.getText();
  if (ts.isTemplateExpression(node)) return JSON.stringify(node.head.text) + node.templateSpans.map((span) => commandText(span.expression, constants, new Set(seen)) + JSON.stringify(span.literal.text)).join('');
  if (ts.isParenthesizedExpression(node)) return commandText(node.expression, constants, seen);
  if (ts.isCallExpression(node)) return node.arguments.map((arg) => commandText(arg, constants, new Set(seen))).join(' ');
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) return commandText(node.left, constants, new Set(seen)) + commandText(node.right, constants, new Set(seen));
  return '';
}

function hasNumericTimeout(node: ts.Expression | undefined): boolean {
  return !!node && (ts.isNumericLiteral(node) || (ts.isObjectLiteralExpression(node) && node.properties.some((property) =>
    ts.isPropertyAssignment(property) && property.name.getText() === 'timeout' && ts.isNumericLiteral(property.initializer))));
}

function testTimeout(call: ts.CallExpression): boolean {
  const name = callName(call);
  if (name === 'test' || name === 'it') return hasNumericTimeout(call.arguments[2]);
  if (name === 'describe') return call.arguments.some((arg) => hasNumericTimeout(arg));
  return false;
}

function withinTimedTest(node: ts.Node): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isCallExpression(parent) && ['test', 'it', 'describe'].includes(callName(parent)) && testTimeout(parent)) return true;
  }
  return false;
}

/** Classify files that actually invoke a Bun/elanous/script subprocess. */
export function classifyTimeouts(file: string, source: string): TimeoutFinding | null {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const constants = new Map<string, ts.Expression>();
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isVariableDeclarationList(node.parent)
      && (node.parent.flags & ts.NodeFlags.Const)) constants.set(node.name.text, node.initializer);
    ts.forEachChild(node, collect);
  };
  collect(tree);
  const lines = new Set<number>();
  let fileDefault = false;
  let uncovered = false;
  const scan = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = callName(node);
      if (name === 'setDefaultTimeout' && node.arguments.length > 0) fileDefault = true;
      if (processCalls.has(name)) {
        const command = node.arguments.slice(0, name === 'execSync' || name.startsWith('Bun.') ? 1 : 2)
          .map((arg) => commandText(arg, constants)).join(' ');
        const executable = node.arguments[0] ? commandText(node.arguments[0], constants) : '';
        if (target.test(command) && !/^\s*"git"/.test(executable)) {
          lines.add(tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1);
          if (!withinTimedTest(node)) uncovered = true;
        }
      }
    }
    ts.forEachChild(node, scan);
  };
  scan(tree);
  if (lines.size === 0) return null;
  return { file, spawnLines: lines.size, timeout: fileDefault ? '파일 기본' : uncovered ? '없음' : '시험별 일부' };
}

export function auditTimeouts(root: string, paths: readonly string[]): TimeoutFinding[] {
  return paths.map((file) => classifyTimeouts(file, readFileSync(join(root, file), 'utf8')))
    .filter((finding): finding is TimeoutFinding => finding !== null)
    .sort((a, b) => a.file.localeCompare(b.file));
}

export function renderTimeouts(findings: readonly TimeoutFinding[], json = false): string {
  if (json) return JSON.stringify(findings, null, 2);
  return ['파일 · 띄우는 줄 수 · 시한 상태', ...findings.map((f) => `${f.file} · ${f.spawnLines} · ${f.timeout}`)].join('\n');
}

export function main(root = process.cwd(), args = process.argv.slice(2)): number {
  if (args.some((arg) => arg !== '--json')) {
    console.error('Usage: bun scripts/test-timeout-audit.ts [--json]');
    return 2;
  }
  const git = spawnSync('git', ['ls-files', '-z', '*.test.ts', '*.test.tsx'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (git.status !== 0 || git.error) {
    console.error(git.error?.message ?? git.stderr ?? 'git ls-files failed');
    return 2;
  }
  const findings = auditTimeouts(root, git.stdout.split('\0').filter(Boolean));
  console.log(renderTimeouts(findings, args.includes('--json')));
  return findings.some((f) => f.timeout === '없음') ? 1 : 0;
}

if (import.meta.main) process.exitCode = main();
