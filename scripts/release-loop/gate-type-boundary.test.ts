import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import ts from 'typescript';

const importers = [
  'scripts/release-loop/gate-triage-node.ts',
  'scripts/release-loop/adaptive-gate-heal.ts',
  'scripts/release-loop/adaptive-gate-heal-adapter.ts',
  'src/release-loop/light-rc.ts',
];

function importsOf(file: string): ts.ImportDeclaration[] {
  const source = readFileSync(file, 'utf8');
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  return parsed.statements.filter(ts.isImportDeclaration);
}

describe('gate type-only boundary', () => {
  test('gate contracts do not statically import the runtime gate node', () => {
    for (const importer of importers) {
      const imports = importsOf(importer);
      const gateTypes = imports.find((entry) => ts.isStringLiteral(entry.moduleSpecifier) && entry.moduleSpecifier.text.endsWith('/gate-types.js'));
      expect(gateTypes, importer).toBeDefined();
      expect(gateTypes?.importClause?.isTypeOnly, importer).toBe(true);
      expect(imports.some((entry) => ts.isStringLiteral(entry.moduleSpecifier) && entry.moduleSpecifier.text.endsWith('/gate-node.js')), importer).toBe(false);
    }

    const facade = readFileSync('scripts/release-loop/gate-node.ts', 'utf8');
    const parsed = ts.createSourceFile('gate-node.ts', facade, ts.ScriptTarget.Latest, true);
    const typeExports = parsed.statements.filter(ts.isExportDeclaration)
      .filter((entry) => entry.isTypeOnly && entry.moduleSpecifier !== undefined && ts.isStringLiteral(entry.moduleSpecifier) && entry.moduleSpecifier.text.endsWith('/gate-types.js'));
    const exported = typeExports.flatMap((entry) => entry.exportClause && ts.isNamedExports(entry.exportClause)
      ? entry.exportClause.elements.map((element) => element.name.text) : []);
    expect(exported).toEqual(expect.arrayContaining(['GateResult', 'GateOptions', 'GateRunner']));
  });

  test('hard rehearsal and API leaf load the extracted runtime without passing through the legacy facade', () => {
    for (const file of ['scripts/release-loop/gate-api-leaf.ts', 'scripts/release-loop/gate-node-cli.ts']) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).toContain("require('./gate-runtime.js')");
      expect(source, file).not.toContain('gate-node.js');
    }
  });
});
