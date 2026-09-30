import { expect, test } from 'bun:test';
import ts from 'typescript';
import { routeMaturity } from '../lib/route-maturity';

// The root layout imports browser providers and Next's build-only font loader.
// Inspect the JSX wiring here; the live banner's pathname rendering is tested
// in role-surfaces.test.tsx without replacing those providers.
test('root layout places the route-selected banner before every page', async () => {
  const source = await Bun.file(new URL('./layout.tsx', import.meta.url)).text();
  const file = ts.createSourceFile('layout.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const imports = file.statements.filter(ts.isImportDeclaration);
  expect(imports.some((entry) => entry.moduleSpecifier.getText(file) === "'@/components/shell/MaturityBanner'"
    && entry.importClause?.namedBindings && ts.isNamedImports(entry.importClause.namedBindings)
    && entry.importClause.namedBindings.elements.some((element) => element.name.text === 'MaturityBanner'))).toBe(true);

  let appShellChildren: ts.JsxChild[] | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(file) === 'AppShell') {
      appShellChildren = [...node.children];
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  expect(appShellChildren).toBeDefined();
  const children = appShellChildren!.filter((node) => !ts.isJsxText(node) || node.getText(file).trim());
  expect(children).toHaveLength(2);
  expect(ts.isJsxSelfClosingElement(children[0]!) && children[0]!.tagName.getText(file) === 'MaturityBanner').toBe(true);
  expect(ts.isJsxExpression(children[1]!) && children[1]!.expression?.getText(file) === 'children').toBe(true);
  expect(routeMaturity('/settings')).toBe('beta');
  expect(routeMaturity('/morning')).toBe('broken');
  expect(routeMaturity('/chat')).toBe('stable');
});
