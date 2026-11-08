import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, test } from 'bun:test';
import { normalizeClaim } from './brief-items.js';

function runtimeModuleSpecifiersOf(path: string): string[] {
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  const specifiers: string[] = [];
  const record = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
      const callee = node.expression;
      if ((ts.isIdentifier(callee) && callee.text === 'require') || callee.kind === ts.SyntaxKind.ImportKeyword) {
        specifiers.push(node.arguments[0].text);
      }
    }
    ts.forEachChild(node, record);
  };
  record(source);
  return specifiers;
}

test('requirement funnel has no runtime edge back to brief-items', () => {
  expect(runtimeModuleSpecifiersOf('src/intake-plane/requirement-funnel.ts')).not.toContain('../briefing/brief-items.js');
  expect(runtimeModuleSpecifiersOf('src/intake-plane/requirement-funnel.ts')).toContain('../briefing/claim-key.js');
});

test('brief-items preserves the normalizeClaim public helper behavior', () => {
  expect(normalizeClaim('  Ｈello\t world ')).toBe('hello world');
});
