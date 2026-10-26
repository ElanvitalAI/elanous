import ts from 'typescript';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

export const ENTRY_LINE_LIMIT = 4_000;
export const ENTRY_MODULE_LIMIT = 1_188;
export const INDEX_MODULE_LIMIT = 1_264;
const DASHBOARD_BASELINE = 'src/dashboard/loop-scheduler.ts';

export interface AuditResult { errors: string[]; notes: string[]; entryModules: number; indexModules: number; oversized: Array<{ file: string; lines: number }> }

function walkTs(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const path = join(root, name);
    return statSync(path).isDirectory() ? walkTs(path) : /\.(?:[cm]?ts|tsx)$/.test(path) ? [path] : [];
  });
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !resolve(path).startsWith(`${resolve(root, 'node_modules')}${sep}`));
}

function staticClosure(repo: string, entry: string): Set<string> {
  const configPath = join(repo, 'tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, repo);
  if (parsed.errors.length) throw new Error(parsed.errors.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')).join('; '));
  const options = parsed.options;
  const seen = new Set<string>();
  const visit = (file: string): void => {
    const abs = resolve(file);
    if (seen.has(abs)) return;
    seen.add(abs);
    const source = ts.createSourceFile(abs, readFileSync(abs, 'utf8'), ts.ScriptTarget.Latest, true);
    for (const node of source.statements) {
      if (ts.isImportDeclaration(node)) {
        if (node.importClause?.isTypeOnly || !ts.isStringLiteral(node.moduleSpecifier)) continue;
        const specifier = node.moduleSpecifier.text;
        const result = ts.resolveModuleName(specifier, abs, options, ts.sys).resolvedModule;
        if (!result) {
          if (specifier.startsWith('.') || specifier.startsWith('/')) throw new Error(`unresolved static import ${relative(repo, abs)} -> ${specifier}`);
          continue;
        }
        if (isInside(repo, result.resolvedFileName)) visit(result.resolvedFileName);
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        if (node.isTypeOnly) continue;
        const specifier = node.moduleSpecifier.text;
        const result = ts.resolveModuleName(specifier, abs, options, ts.sys).resolvedModule;
        if (!result) {
          if (specifier.startsWith('.') || specifier.startsWith('/')) throw new Error(`unresolved static re-export ${relative(repo, abs)} -> ${specifier}`);
          continue;
        }
        if (isInside(repo, result.resolvedFileName)) visit(result.resolvedFileName);
      }
    }
  };
  visit(entry);
  return seen;
}

export function entryBudgetAffected(changedFiles: readonly string[]): boolean {
  if (changedFiles.some((file) => file === 'bin/elanous.mjs' || file === 'tsconfig.json' || file === 'scripts/ratchets/next-tui-entry-budget.ts')) return true;
  // Any source edit can add/remove an importer or delete a module from a base
  // closure. The changed tree alone cannot prove non-membership in the base graph.
  return changedFiles.some((file) => /^src\/.+\.[cm]?[jt]sx?$/.test(file));
}

export function audit(repo: string): AuditResult {
  const errors: string[] = [];
  const notes: string[] = [];
  const tuiFiles = [join(repo, 'src/tui.ts'), ...walkTs(join(repo, 'src/tui'))];
  const oversized = tuiFiles.map((file) => {
    const contents = readFileSync(file, 'utf8');
    const lines = contents.length === 0 ? 0 : contents.split(/\r?\n/).length - (contents.endsWith('\n') ? 1 : 0);
    return { file: relative(repo, file), lines };
  })
    .filter(({ lines }) => lines > ENTRY_LINE_LIMIT);
  for (const item of oversized) errors.push(`${item.file}: ${item.lines} lines exceeds ${ENTRY_LINE_LIMIT}`);

  const entryClosure = staticClosure(repo, join(repo, 'src/tui/entry.ts'));
  const entryPaths = [...entryClosure].map((file) => relative(repo, file).replaceAll('\\', '/'));
  if (entryClosure.size > ENTRY_MODULE_LIMIT) errors.push(`Next entry static module count ${entryClosure.size} exceeds ${ENTRY_MODULE_LIMIT}`);
  else if (entryClosure.size < ENTRY_MODULE_LIMIT) notes.push(`tighten entry module cap ${ENTRY_MODULE_LIMIT} -> ${entryClosure.size}`);
  const forbiddenIndex = entryPaths.filter((p) => p === 'src/index.ts');
  if (forbiddenIndex.length) errors.push('Next entry statically imports forbidden src/index.ts');
  const dashboard = entryPaths.filter((p) => p.startsWith('src/dashboard/'));
  const unexpectedDashboard = dashboard.filter((p) => p !== DASHBOARD_BASELINE);
  if (unexpectedDashboard.length) errors.push(`forbidden dashboard static imports: ${unexpectedDashboard.join(', ')}`);
  if (dashboard.includes(DASHBOARD_BASELINE)) notes.push(`${DASHBOARD_BASELINE} is temporary baseline; remove at NEXT-TUI-EXTRACT-FROM-INDEX`);

  const binPath = join(repo, 'bin/elanous.mjs');
  const bin = readFileSync(binPath, 'utf8');
  // The deployment entry sends every unrecognized route to src/index.ts. The current
  // light router does not claim --tui next, so measure that fallback's static closure.
  const binSource = ts.createSourceFile(binPath, bin, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let importsIndex = false;
  const visitBin = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments[0] && ts.isStringLiteral(node.arguments[0])
      && /(?:^|\/)src\/index\.ts$/.test(node.arguments[0].text.replaceAll('\\', '/'))) importsIndex = true;
    ts.forEachChild(node, visitBin);
  };
  visitBin(binSource);
  const indexClosure = importsIndex ? staticClosure(repo, join(repo, 'src/index.ts')) : new Set<string>();
  if (importsIndex && indexClosure.size > INDEX_MODULE_LIMIT) errors.push(`bin --tui next index static module count ${indexClosure.size} exceeds ${INDEX_MODULE_LIMIT}`);
  else if (importsIndex && indexClosure.size < INDEX_MODULE_LIMIT) notes.push(`tighten index module cap ${INDEX_MODULE_LIMIT} -> ${indexClosure.size} after entry extraction`);
  else if (!importsIndex) notes.push('bin has no dynamic import of src/index.ts; index fallback budget no longer applies');
  return { errors, notes, entryModules: entryClosure.size, indexModules: indexClosure.size, oversized };
}

if (import.meta.main) {
  try {
    const result = audit(resolve(dirname(new URL(import.meta.url).pathname), '../..'));
    console.log(`NEXT_TUI_ENTRY_BUDGET entryModules=${result.entryModules} indexModules=${result.indexModules} oversized=${result.oversized.length}`);
    for (const note of result.notes) console.log(`NOTE ${note}`);
    for (const error of result.errors) console.error(`FAIL ${error}`);
    process.exitCode = result.errors.length ? 1 : 0;
  } catch (error) {
    console.error(`UNMEASURED ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
