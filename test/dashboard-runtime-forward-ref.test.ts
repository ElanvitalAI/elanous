import { describe, expect, test } from 'bun:test';
import ts from 'typescript';
import { readDashboardSources, type DashboardSource } from './helpers/dashboard-source.js';

interface ForwardRefIssue {
  path: string;
  callee: string;
  ident: string;
  callLine: number;
  declLine: number;
}

const RUNTIME_CALLEE = /^(createDashboard.*Runtime|bootDashboard[A-Z].*|createDashboardClipboardActions)$/;

function collectDashboardRuntimeForwardRefs({ path, text }: DashboardSource): ForwardRefIssue[] {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lineOf = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const issues: ForwardRefIssue[] = [];

  const inspectBody = (body: ts.Block): void => {
    const declarations = new Map<string, { line: number; kind: 'function' | 'variable' }>();
    for (const stmt of body.statements) {
      if (ts.isVariableStatement(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) {
            declarations.set(decl.name.text, { line: lineOf(decl.name.pos), kind: 'variable' });
          }
        }
        continue;
      }
      if (ts.isFunctionDeclaration(stmt) && stmt.name) {
        declarations.set(stmt.name.text, { line: lineOf(stmt.name.pos), kind: 'function' });
      }
    }

    const inspect = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node)
        && ts.isIdentifier(node.expression)
        && RUNTIME_CALLEE.test(node.expression.text)
      ) {
        const callLine = lineOf(node.getStart(sf));
        const [arg0] = node.arguments;
        if (arg0 && ts.isObjectLiteralExpression(arg0)) {
          for (const prop of arg0.properties) {
            const ident = ts.isShorthandPropertyAssignment(prop)
              ? prop.name.text
              : ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.initializer)
                ? prop.initializer.text
                : undefined;
            if (!ident) continue;
            const decl = declarations.get(ident);
            if (decl && decl.kind === 'variable' && decl.line > callLine) {
              issues.push({ path, callee: node.expression.text, ident, callLine, declLine: decl.line });
            }
          }
        }
      }
      ts.forEachChild(node, inspect);
    };
    inspect(body);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.body) inspectBody(node.body);
    else if (ts.isVariableDeclaration(node) && node.initializer && ts.isArrowFunction(node.initializer)
      && ts.isBlock(node.initializer.body)) inspectBody(node.initializer.body);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return issues;
}

describe('dashboard runtime forward-ref guard', () => {
  test('runtime boot calls do not directly capture later const bindings', () => {
    const issues = readDashboardSources().flatMap(collectDashboardRuntimeForwardRefs);
    expect(issues.map((issue) => `${issue.path}:${issue.callLine} ${issue.callee} captures ${issue.ident} declared at ${issue.path}:${issue.declLine}`)).toEqual([]);
  });
});
