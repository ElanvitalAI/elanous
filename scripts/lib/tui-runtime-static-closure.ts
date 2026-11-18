import ts from 'typescript';

export function runtimeStaticSpecifiers(source: string): string[] {
  const file = ts.createSourceFile('module.ts', source, ts.ScriptTarget.Latest, true);
  const specifiers: string[] = [];
  const walk = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
      && !node.importClause?.isTypeOnly
      && !(node.importClause && !node.importClause.name && node.importClause.namedBindings
        && ts.isNamedImports(node.importClause.namedBindings)
        && node.importClause.namedBindings.elements.length > 0
        && node.importClause.namedBindings.elements.every((element) => element.isTypeOnly))) {
      specifiers.push(node.moduleSpecifier.text);
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
      && !node.isTypeOnly
      && !(node.exportClause && ts.isNamedExports(node.exportClause)
        && node.exportClause.elements.length > 0
        && node.exportClause.elements.every((element) => element.isTypeOnly))) {
      specifiers.push(node.moduleSpecifier.text);
    }
    ts.forEachChild(node, walk);
  };
  walk(file);
  return specifiers;
}
