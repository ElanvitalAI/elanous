import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, test } from 'bun:test';
import { createDefaultMenuPresenter } from './context-menu-presenter.js';
import type { ModalSurface } from '../display/modal-stack.js';

test('submenu contract keeps its recipe type dependency erased at runtime', () => {
  const source = ts.createSourceFile('src/ui/submenu-popup-menu-contract.ts',
    readFileSync('src/ui/submenu-popup-menu-contract.ts', 'utf8'), ts.ScriptTarget.Latest, true);
  const runtimeBackEdges = source.statements.flatMap((statement) => {
    if (ts.isImportDeclaration(statement) && !statement.importClause?.isTypeOnly
      && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === '../mouse-action-recipes.js') return [statement.moduleSpecifier.text];
    if (ts.isExportDeclaration(statement) && !statement.isTypeOnly && statement.moduleSpecifier
      && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === '../mouse-action-recipes.js') return [statement.moduleSpecifier.text];
    return [];
  });
  const runtimeCalls: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const [specifier] = node.arguments;
      if (ts.isStringLiteral(specifier) && specifier.text === '../mouse-action-recipes.js'
        && (node.expression.kind === ts.SyntaxKind.ImportKeyword
          || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
        runtimeCalls.push(specifier.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(runtimeBackEdges).toEqual([]);
  expect(runtimeCalls).toEqual([]);
});

test('default presenter still opens and resolves a nested command submenu', async () => {
  const pushed: ModalSurface[] = [];
  const presenter = createDefaultMenuPresenter({
    termSize: () => ({ rows: 24, cols: 80 }),
    pushSurface: surface => {
      pushed.push(surface);
      return { dispose: () => { const i = pushed.indexOf(surface); if (i >= 0) pushed.splice(i, 1); } };
    },
  });
  const resultP = presenter({
    title: 'Root',
    items: [{ kind: 'command', id: 'parent', label: 'Parent', submenu: {
      title: 'Child',
      items: [{ kind: 'command', id: 'child', label: 'Child action' }],
    } }],
  }, { x: 3, y: 4 }, {});

  expect(pushed).toHaveLength(1);
  pushed[0]!.paint();
  pushed[0]!.onKey?.({ name: 'enter' } as never);
  expect(pushed).toHaveLength(1);
  pushed[0]!.paint();
  pushed[0]!.onKey?.({ name: 'enter' } as never);
  await expect(resultP).resolves.toEqual({ value: 'child', reason: 'selected' });
  expect(pushed).toHaveLength(0);
});
