#!/usr/bin/env bun
/** Report CLI JSON handlers that can exit after an unawaited stdout write. */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

export interface JsonExitFinding { file: string; line: number; exitLine: number }

function namedCall(node: ts.Node, object: string, method: string): node is ts.CallExpression {
  return ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
    && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === object
    && node.expression.name.text === method;
}

function isOutput(node: ts.Node): boolean {
  return namedCall(node, 'console', 'log') || (ts.isCallExpression(node)
    && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'write'
    && ts.isPropertyAccessExpression(node.expression.expression)
    && node.expression.expression.name.text === 'stdout'
    && ts.isIdentifier(node.expression.expression.expression)
    && node.expression.expression.expression.text === 'process');
}

function isExit(node: ts.Node): boolean { return namedCall(node, 'process', 'exit'); }
function isJsonRead(node: ts.Node): boolean {
  return ts.isPropertyAccessExpression(node) && node.name.text === 'json'
    && ts.isIdentifier(node.expression) && (node.expression.text === 'opts' || node.expression.text === 'options');
}
function isFunction(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)
    || ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node);
}

/** Positions are lines of the raw write; exits are recorded separately for auditing. */
export function scanJsonExitSource(source: string, file: string): JsonExitFinding[] {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const findings: JsonExitFinding[] = [];
  const line = (node: ts.Node) => tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
  const visit = (node: ts.Node): void => {
    if (isFunction(node)) {
      const outputs: ts.Node[] = [];
      const exits: ts.Node[] = [];
      const body = node.body;
      const collect = (child: ts.Node): void => {
        if (child !== node && isFunction(child)) return;
        if (isOutput(child)) outputs.push(child);
        if (isExit(child)) exits.push(child);
        ts.forEachChild(child, collect);
      };
      if (body) collect(body);
      const readsJson = (expression: ts.Node): boolean => {
        let found = false;
        const inspect = (child: ts.Node): void => {
          if (child !== expression && isFunction(child)) return;
          if (isJsonRead(child)) found = true;
          ts.forEachChild(child, inspect);
        };
        inspect(expression);
        return found;
      };
      if (!body || !readsJson(body)) { ts.forEachChild(node, visit); return; }
      // Exclude human-only arms even when the handler also has a JSON path.
      const jsonArm = (output: ts.Node): ts.Statement | undefined => {
        for (let parent = output.parent; parent && parent !== node; parent = parent.parent) {
          if (ts.isIfStatement(parent) && output.getStart(tree) >= parent.thenStatement.getStart(tree)
            && output.getEnd() <= parent.thenStatement.getEnd() && readsJson(parent.expression)
            && !parent.expression.getText(tree).trimStart().startsWith('!')) return parent.thenStatement;
        }
        return undefined;
      };
      for (const output of outputs) {
        const arm = jsonArm(output);
        let jsonConditionalOutput = false;
        if (ts.isCallExpression(output)) {
          const inspect = (child: ts.Node): void => {
            if (ts.isConditionalExpression(child) && readsJson(child.condition)) jsonConditionalOutput = true;
            ts.forEachChild(child, inspect);
          };
          for (const arg of output.arguments) inspect(arg);
        }
        if (!arm && !jsonConditionalOutput) continue;
        const armReturns = arm && (() => {
          let returns = false;
          const inspect = (child: ts.Node): void => {
            if (isFunction(child)) return;
            if (ts.isReturnStatement(child)) returns = true;
            ts.forEachChild(child, inspect);
          };
          inspect(arm);
          return returns;
        })();
        const exit = exits.find(candidate => candidate.getStart(tree) > output.getStart(tree)
          && (!arm || candidate.getStart(tree) <= arm.getEnd() || !armReturns));
        if (exit) findings.push({ file, line: line(output), exitLine: line(exit) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return findings;
}

function cliFiles(root: string): string[] {
  const files = [join(root, 'src/index.ts')];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name));
      else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) files.push(join(dir, entry.name));
    }
  };
  walk(join(root, 'src/cli'));
  return files.sort();
}

export function scanCliJsonExits(root = join(import.meta.dir, '..')): JsonExitFinding[] {
  return cliFiles(root).flatMap(path => scanJsonExitSource(readFileSync(path, 'utf8'), relative(root, path)));
}

if (import.meta.main) {
  const findings = scanCliJsonExits();
  if (process.argv.includes('--json')) console.log(JSON.stringify(findings, null, 2));
  else {
    console.log(`JSON 출력 → process.exit 후보 ${findings.length}곳 (file:writeLine → exitLine)`);
    for (const finding of findings) console.log(`${finding.file}:${finding.line} → ${finding.exitLine}`);
  }
}
