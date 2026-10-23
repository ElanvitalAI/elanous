import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { debug } from '../debug/log.js';

type GraphFiles = {
  readFile?: (path: string) => string;
  listFiles?: (cwd: string) => string[];
};

function sourceFiles(cwd: string): string[] {
  const files: string[] = [];
  for (const root of ['apps/pwa/src', 'src']) {
    const walk = (dir: string): void => {
      let entries;
      try { entries = readdirSync(join(cwd, dir), { withFileTypes: true }); }
      catch { return; }
      for (const entry of entries) {
        const path = `${dir}/${entry.name}`;
        if (entry.isDirectory() && !['node_modules', '.next'].includes(entry.name)) walk(path);
        else if (entry.isFile() && /\.(?:ts|tsx|js)$/.test(path)) files.push(path);
      }
    };
    walk(root);
  }
  return files;
}

const IMPORT_SPECIFIER = /\b(?:import|export)\s+(?:[^;'"]*?\s+from\s*)?['"](\.[^'"]+)['"]|\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g;

/** Repo-relative file candidates a relative import specifier (already joined to its importer's directory) can resolve to. */
export function importCandidates(base: string): string[] {
  return /\.js$/.test(base)
    // A real .js file wins over a same-named .ts source (the actual resolution order).
    ? [base, base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'), `${base.slice(0, -3)}/index.ts`, `${base.slice(0, -3)}/index.tsx`, `${base.slice(0, -3)}/index.js`]
    : /\.tsx?$/.test(base) ? [base] : [base + '.ts', base + '.tsx', base + '.js', base + '/index.ts', base + '/index.tsx', base + '/index.js'];
}

/** PWA source entrypoints and the transitive relative imports they resolve inside repository src/. */
export function pwaReachableSrcFiles(cwd: string, { readFile = (path) => readFileSync(path, 'utf8'), listFiles = sourceFiles }: GraphFiles = {}): Set<string> {
  const root = resolve(cwd);
  const available = new Set(listFiles(cwd).map((file) => file.replaceAll('\\', '/').replace(/^\.\//, '')));
  const reached = new Set<string>();
  const visited = new Set<string>();
  // Start from everything apps/pwa/tsconfig.json `include`s — its `src/**/*.ts(x)` also matches *.test.* files, and the Next
  // build type-checks them. Excluding tests hid the real entry (tool-result-chain.test.ts → src/nexus/api/meta-api → most of src).
  const queue = [...available].filter((file) => /^apps\/pwa\/src\/.*\.tsx?$/.test(file));
  while (queue.length) {
    const file = queue.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    if (file.startsWith('src/')) reached.add(file);
    let content: string;
    try { content = readFile(join(root, file)); }
    catch { continue; }
    for (const match of content.matchAll(IMPORT_SPECIFIER)) {
      const specifier = match[1] ?? match[2];
      if (!specifier) continue;
      const target = resolve(root, dirname(file), specifier);
      const base = relative(root, target).split(sep).join('/');
      if (!base.startsWith('src/')) continue;
      const candidates = importCandidates(base);
      const resolved = candidates.find((candidate) => available.has(candidate));
      if (resolved) {
        if (!visited.has(resolved)) queue.push(resolved);
      } else {
        // An import of a deleted src file must still trigger the build that reports it.
        for (const candidate of candidates) reached.add(candidate);
      }
    }
  }
  return reached;
}

export type AffectedRoots = { roots: Set<string>; failure?: undefined } | { roots?: undefined; failure: string };

function astImportSpecifiers(source: ts.SourceFile): { imports: string[]; ignoredDynamic: number; failure?: string } {
  const parseError = (source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics?.[0];
  if (parseError) return { imports: [], ignoredDynamic: 0, failure: `${source.fileName} AST 파싱 실패: ${ts.flattenDiagnosticMessageText(parseError.messageText, ' ')}` };
  const imports: string[] = [];
  let ignoredDynamic = 0;
  const literal = (node: ts.Node | undefined): string | undefined => node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = literal(node.moduleSpecifier);
      if (specifier) imports.push(specifier);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const specifier = literal(node.moduleReference.expression);
      if (specifier) imports.push(specifier);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      const specifier = literal(node.argument.literal);
      if (specifier) imports.push(specifier);
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      const specifier = literal(node.arguments[0]);
      if (specifier) imports.push(specifier);
      else ignoredDynamic += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { imports, ignoredDynamic };
}

function reExportSpecifiers(source: ts.SourceFile): string[] {
  const importedLocals = new Map<string, string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const from = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (clause?.name) importedLocals.set(clause.name.text, from);
    const bindings = clause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) importedLocals.set(bindings.name.text, from);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) importedLocals.set(element.name.text, from);
    }
  }
  const specifiers: string[] = [];
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) specifiers.push(statement.moduleSpecifier.text);
      else if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          const from = importedLocals.get((element.propertyName ?? element.name).text);
          if (from) specifiers.push(from);
        }
      }
    } else if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) {
      const from = importedLocals.get(statement.expression.text);
      if (from) specifiers.push(from);
    }
  }
  return specifiers;
}

/** Declarations visible without an import edge must enter every scoped program. */
function suppliesAmbientTypes(source: ts.SourceFile): boolean {
  if (source.fileName.endsWith('.d.ts') || !ts.isExternalModule(source)) return true;
  const visit = (node: ts.Node): boolean => {
    if (ts.isModuleDeclaration(node) && (node.name.text === 'global' || ts.isStringLiteral(node.name))) return true;
    return ts.forEachChild(node, visit) ?? false;
  };
  return visit(source);
}

function gateTypeScriptSources(cwd: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    // A partial directory walk is not a valid affected-root measurement: an
    // unreadable subtree may contain the only importer of a changed file.
    const entries = readdirSync(join(cwd, dir), { withFileTypes: true });
    for (const entry of entries) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.')) walk(path);
      else if (entry.isFile() && /\.ts$/.test(path)) files.push(path);
    }
  };
  for (const root of ['src', 'scripts', 'test']) {
    // An optional include glob may match no directory in a fixture. Only a
    // confirmed ENOENT is empty; permission/I/O errors must fail closed.
    try { statSync(join(cwd, root)); }
    catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw cause;
    }
    walk(root);
  }
  return files;
}

/**
 * Changed .ts files plus the listed files that import one of them directly (one reverse-import step).
 * Every changed file and every listed file must be readable — an unreadable file could be a hidden importer, so the
 * result is a failure the caller turns into a full-program run, never a smaller root set.
 */
export function reverseImportAffectedRoots(cwd: string, changed: ReadonlySet<string>, { readFile = (path) => readFileSync(path, 'utf8'), listFiles = gateTypeScriptSources }: GraphFiles = {}): AffectedRoots {
  const root = resolve(cwd);
  const normalize = (file: string): string => file.replaceAll('\\', '/').replace(/^\.\//, '');
  const read = (file: string): string | { failure: string } => {
    try { return readFile(join(root, file)); }
    catch (cause) { return { failure: `${file} 을 읽지 못했다: ${cause instanceof Error ? cause.message : String(cause)}` }; }
  };
  let listed: string[];
  try { listed = listFiles(cwd).map(normalize); }
  catch (cause) { return { failure: `소스 목록을 읽지 못했다: ${cause instanceof Error ? cause.message : String(cause)}` }; }
  const available = new Set(listed);
  const targets = new Set([...changed].map(normalize));
  for (const file of targets) {
    const content = read(file);
    if (typeof content !== 'string') return content;
  }
  const importsByFile = new Map<string, Set<string>>();
  const barrelsByTarget = new Map<string, Set<string>>();
  const ambientRoots = new Set<string>();
  let ignoredDynamic = 0;
  const resolveImport = (file: string, specifier: string): { target?: string; ignored?: true; unresolved?: true } => {
    if (!specifier.startsWith('.')) return { ignored: true };
    const base = relative(root, resolve(root, dirname(file), specifier)).split(sep).join('/');
    // The gate's tsconfig includes these roots. A relative import outside them
    // cannot lead back to a changed gate source; asset imports are not TS
    // source edges either.
    if (!/^(?:src|scripts|test)\//.test(base) || /\.(?:css|json|svg|png|jpg|jpeg|webp|wasm)$/.test(base)) return { ignored: true };
    const target = importCandidates(base).find((candidate) => available.has(candidate));
    return target ? { target } : { unresolved: true };
  };
  for (const file of listed) {
    const content = read(file);
    if (typeof content !== 'string') return content;
    let source: ts.SourceFile;
    try { source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true); }
    catch (cause) { return { failure: `${file} AST 파싱 실패: ${cause instanceof Error ? cause.message : String(cause)}` }; }
    const scanned = astImportSpecifiers(source);
    if (scanned.failure) return { failure: scanned.failure };
    if (suppliesAmbientTypes(source)) ambientRoots.add(file);
    ignoredDynamic += scanned.ignoredDynamic;
    const imports = new Set<string>();
    for (const specifier of scanned.imports) {
      if (!specifier.startsWith('.')) continue;
      const resolved = resolveImport(file, specifier);
      if (resolved.unresolved) return { failure: `${file} 의 리터럴 import ${specifier} 해석 실패` };
      if (resolved.target) imports.add(resolved.target);
    }
    importsByFile.set(file, imports);
    for (const specifier of reExportSpecifiers(source)) {
      const resolved = resolveImport(file, specifier);
      if (resolved.unresolved) return { failure: `${file} 의 리터럴 re-export ${specifier} 해석 실패` };
      if (!resolved.target) continue;
      const barrels = barrelsByTarget.get(resolved.target) ?? new Set<string>();
      barrels.add(file);
      barrelsByTarget.set(resolved.target, barrels);
    }
  }
  if (ignoredDynamic) debug.log('typecheck.gate', 'nonliteral-import-ignored', { count: ignoredDynamic });
  // A changed export can break an importer through any number of re-export
  // barrels. Walk that chain to a fixed point, then include direct importers
  // of each barrel. The visited set also terminates circular barrels.
  const exported = new Set(targets);
  const queue = [...targets];
  while (queue.length) {
    const target = queue.pop()!;
    for (const barrel of barrelsByTarget.get(target) ?? []) {
      if (exported.has(barrel)) continue;
      exported.add(barrel);
      queue.push(barrel);
    }
  }
  const roots = new Set([...exported, ...ambientRoots]);
  for (const [file, imports] of importsByFile) {
    if ([...imports].some((target) => exported.has(target))) roots.add(file);
  }
  return { roots };
}
