import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, resolve, sep } from 'node:path';
import ts from 'typescript';
import { siblingTestPath } from '../self-dev/launch-preflight-text.js';

// A generated evidence check is a smoke test. Large integration files belong in the
// changed gate, where they have a separate budget and failure attribution.
export const EVIDENCE_TEST_MAX_BYTES = 64 * 1024;

/** An empty seam value is unresolved and must use the real HEAD reader. */
export function resolveEvidenceHeadCommit(seamHead: string | undefined, readHead: () => string | undefined): string | undefined {
  return seamHead?.trim() || readHead()?.trim() || undefined;
}

function directlyImportsTarget(path: string, source: string, targetSpecifiers: ReadonlySet<string>): boolean {
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
      && !node.importClause?.isTypeOnly
      && !(node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)
        && !node.importClause.name && node.importClause.namedBindings.elements.every((element) => element.isTypeOnly))) {
      found = targetSpecifiers.has(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
      found = targetSpecifiers.has(node.arguments[0].text);
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(ast);
  return found;
}

/** Pick a small test that directly imports the target; never substitute an unrelated test. */
export function focusedEvidenceTestPath(target: string, repositoryRoot?: string): string | null {
  const sibling = siblingTestPath(target);
  if (!sibling) return null;
  if (!repositoryRoot) return sibling;
  const root = resolve(repositoryRoot);
  const absolute = resolve(root, sibling);
  if (!absolute.startsWith(`${root}${sep}`)) return null;
  try {
    // Authoring can precede creation of its declared test file. Preserve that
    // existing command contract; the size budget only applies to a measured file.
    if (!existsSync(absolute)) return sibling;
    // Follow a symlink so its target's measured size, not link text length, sets the budget.
    const siblingStat = statSync(absolute);
    if (siblingStat.isFile() && siblingStat.size <= EVIDENCE_TEST_MAX_BYTES) return sibling;
    const stem = basename(target, '.ts');
    const importName = `./${stem}`;
    const targetSpecifiers = new Set([`${importName}.js`, `${importName}.ts`, importName]);
    const candidates = readdirSync(dirname(absolute))
      .filter((name) => name.startsWith(`${stem}-`) && name.endsWith('.test.ts') && !/['\\]/u.test(name))
      .map((name) => ({ name, absolute: resolve(dirname(absolute), name) }))
      .flatMap(({ name, absolute: path }) => {
        // Match the sibling rule: a linked test is measured by its target.
        const stat = statSync(path);
        if (!stat.isFile() || stat.size > EVIDENCE_TEST_MAX_BYTES) return [];
        const source = readFileSync(path, 'utf8');
        return directlyImportsTarget(path, source, targetSpecifiers) ? [{ name, size: stat.size }] : [];
      })
      .sort((a, b) => a.size - b.size || a.name.localeCompare(b.name));
    return candidates.length ? `${dirname(sibling)}/${candidates[0]!.name}` : null;
  } catch {
    return null;
  }
}

/** Only rewrite a single, safely quoted generated Bun test command. */
export function narrowerEvidenceCommand(command: string, repositoryRoot: string): string | null {
  const match = /^bun test -- '([^']+)'$/u.exec(command);
  // Generated paths with shell quote escapes are deliberately left untouched here.
  if (!match || match[1]!.includes('\\')) return null;
  const testPath = match[1]!;
  if (!testPath.endsWith('.test.ts')) return null;
  const target = `${testPath.slice(0, -'.test.ts'.length)}.ts`;
  const focused = focusedEvidenceTestPath(target, repositoryRoot);
  return focused && focused !== testPath && !/['\\]/u.test(focused) ? `bun test -- '${focused}'` : null;
}
