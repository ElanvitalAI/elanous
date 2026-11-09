import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, test } from 'bun:test';
import { frontmatterText, parseSkillMd } from '../skills/runner.js';

function importsOf(path: string): Array<{ specifier: string; typeOnly: boolean }> {
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  return source.statements.flatMap((statement) => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) return [];
    return [{ specifier: statement.moduleSpecifier.text, typeOnly: !!statement.importClause?.isTypeOnly }];
  });
}

test('agent loader uses the leaf skill parser without a runtime edge back to runner', () => {
  const imports = importsOf('src/agent/loader.ts');
  expect(imports).toContainEqual({ specifier: '../skills/skill-manifest.js', typeOnly: false });
  expect(imports).toContainEqual({ specifier: '../skills/runner.js', typeOnly: true });
  expect(imports.some((entry) => entry.specifier === '../skills/runner.js' && !entry.typeOnly)).toBe(false);
});

test('runner keeps its public skill parser exports after extraction', () => {
  expect(typeof parseSkillMd).toBe('function');
  expect(frontmatterText(['skill', 'description'])).toBe('skill description');
});
