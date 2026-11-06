import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type * as TS from 'typescript';
import tsApi from './lazy-typescript.js';
import { importCandidates } from './pwa-import-graph.js';

export interface UnwiredExport {
  file: string;
  name: string;
  reason: 'no-production-importer';
}

export interface WiringCheckResult {
  checked: number;
  unwired: UnwiredExport[];
  failure?: string;
}

export interface WiringCheckInput {
  cwd: string;
  changedFiles: readonly string[];
  /**
   * Undefined means the file did not exist at the run's resolved base.
   * A read that could not be completed (timeout, git error) must throw so the
   * check records a failure instead of treating every old export as new.
   */
  readBaseFile: (file: string) => string | undefined;
  readFile?: (absolutePath: string) => string;
  listFiles?: (cwd: string) => string[];
}

export interface BaseGitResult {
  status: number | null;
  signal?: string | null;
  errorCode?: string;
  stdout: string;
  stderr: string;
}
export type BaseGitRun = (args: string[]) => BaseGitResult;

function gitFailed(result: BaseGitResult): boolean {
  return result.status !== 0 || !!result.signal || !!result.errorCode;
}

function describeGit(result: BaseGitResult): string {
  return [
    `status=${result.status}`,
    result.signal ? `signal=${result.signal}` : '',
    result.errorCode ? `error=${result.errorCode}` : '',
    result.stderr.trim().split(/\r?\n/)[0] ?? '',
  ].filter(Boolean).join(' ');
}

/**
 * Reads a file at `base`. Absence is decided by a successful tree listing that
 * names nothing; any timeout or git error throws (`base-read-failed`).
 */
export function gitBaseFileReader(run: BaseGitRun, base: string): (file: string) => string | undefined {
  return (file) => {
    const listed = run(['ls-tree', '-z', '--name-only', base, '--', file]);
    if (gitFailed(listed)) throw new Error(`base-read-failed: ${file}: ls-tree ${describeGit(listed)}`);
    if (!listed.stdout.split('\0').some((entry) => entry === file)) return undefined;
    const shown = run(['show', `${base}:${file}`]);
    if (gitFailed(shown)) throw new Error(`base-read-failed: ${file}: show ${describeGit(shown)}`);
    return shown.stdout;
  };
}

// Only the repository's executable wrapper and root CLI module are known
// dynamic/public entry surfaces. Ordinary domain index modules are analyzable.
const ENTRYPOINT = /^(?:bin\/|src\/index\.tsx?$)/;
const SOURCE = /^(?:src\/|scripts\/|apps\/pwa\/src\/).+\.tsx?$/;
const TEST = /(?:^|\/)(?:test\/|__tests__\/)|(?:\.test|\.spec|\.d)\.tsx?$/;

function productionFiles(cwd: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try { entries = readdirSync(join(cwd, dir), { withFileTypes: true }); }
    catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw cause;
    }
    for (const entry of entries) {
      const file = `${dir}/${entry.name}`;
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') walk(file);
      else if (entry.isFile() && SOURCE.test(file) && !TEST.test(file)) files.push(file);
    }
  };
  for (const root of ['src', 'scripts', 'apps/pwa/src']) walk(root);
  return files;
}

function sourceFile(file: string, content: string): TS.SourceFile {
  const absolute = resolve(file);
  return tsApi.createSourceFile(absolute, content, tsApi.ScriptTarget.Latest, true, absolute.endsWith('.tsx') ? tsApi.ScriptKind.TSX : tsApi.ScriptKind.TS);
}

function hasModifier(node: TS.Node, kind: TS.SyntaxKind): boolean {
  const modifiers = tsApi.canHaveModifiers(node) ? tsApi.getModifiers(node) : undefined;
  return !!modifiers?.some((modifier) => modifier.kind === kind);
}

/** True when the statement produces a value at runtime (not ambient, not erased). */
function isRuntimeDeclaration(statement: TS.Statement): boolean {
  if (hasModifier(statement, tsApi.SyntaxKind.DeclareKeyword)) return false;
  if (tsApi.isFunctionDeclaration(statement)) return !!statement.body;
  if (tsApi.isEnumDeclaration(statement)) return !hasModifier(statement, tsApi.SyntaxKind.ConstKeyword);
  return tsApi.isClassDeclaration(statement) || tsApi.isVariableStatement(statement);
}

/** Public export name → local binding name (null when the default export has no local name). */
function exportedValues(source: TS.SourceFile): Map<string, string | null> {
  const names = new Map<string, string | null>();
  for (const statement of source.statements) {
    const exported = hasModifier(statement, tsApi.SyntaxKind.ExportKeyword);
    const isDefault = hasModifier(statement, tsApi.SyntaxKind.DefaultKeyword);
    if (exported && isRuntimeDeclaration(statement)) {
      if (tsApi.isFunctionDeclaration(statement) || tsApi.isClassDeclaration(statement) || tsApi.isEnumDeclaration(statement)) {
        if (isDefault) names.set('default', statement.name?.text ?? null);
        else if (statement.name) names.set(statement.name.text, statement.name.text);
      }
      if (tsApi.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (tsApi.isIdentifier(declaration.name)) names.set(declaration.name.text, declaration.name.text);
        }
      }
    }
    if (tsApi.isExportAssignment(statement) && !statement.isExportEquals) {
      if (!tsApi.isIdentifier(statement.expression)) names.set('default', null);
      else if (bindingIdentifier(source, statement.expression.text)) names.set('default', statement.expression.text);
    }
    if (tsApi.isExportDeclaration(statement) && !statement.isTypeOnly && !statement.moduleSpecifier
      && statement.exportClause && tsApi.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        const localName = (element.propertyName ?? element.name).text;
        // Re-exporting a type alias, interface or ambient binding creates no runtime value.
        if (!element.isTypeOnly && bindingIdentifier(source, localName)) names.set(element.name.text, localName);
      }
    }
  }
  return names;
}

const checkerCache = new WeakMap<TS.SourceFile, TS.TypeChecker>();

function checkerFor(source: TS.SourceFile): TS.TypeChecker {
  const cached = checkerCache.get(source);
  if (cached) return cached;
  const options: TS.CompilerOptions = { noResolve: true, noLib: true, target: tsApi.ScriptTarget.Latest };
  const host = tsApi.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) =>
    resolve(fileName) === source.fileName
      ? source
      : getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
  const program = tsApi.createProgram([source.fileName], options, host);
  const checker = program.getTypeChecker();
  checkerCache.set(source, checker);
  return checker;
}

/** The runtime binding for `name` in this file, or undefined (types and ambient declarations have none). */
function bindingIdentifier(source: TS.SourceFile, name: string): TS.Identifier | undefined {
  const fromBindingName = (node: TS.BindingName): TS.Identifier | undefined => {
    if (tsApi.isIdentifier(node)) return node.text === name ? node : undefined;
    for (const element of node.elements) {
      if (tsApi.isOmittedExpression(element)) continue;
      const found = fromBindingName(element.name);
      if (found) return found;
    }
    return undefined;
  };
  for (const statement of source.statements) {
    if ((tsApi.isFunctionDeclaration(statement) || tsApi.isClassDeclaration(statement)
      || tsApi.isEnumDeclaration(statement)) && statement.name?.text === name) {
      if (isRuntimeDeclaration(statement)) return statement.name;
      continue;
    }
    if (tsApi.isVariableStatement(statement) && isRuntimeDeclaration(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const found = fromBindingName(declaration.name);
        if (found) return found;
      }
    }
    if (tsApi.isImportDeclaration(statement) && statement.importClause && !statement.importClause.isTypeOnly) {
      const clause = statement.importClause;
      if (clause.name?.text === name) return clause.name;
      if (clause.namedBindings && tsApi.isNamespaceImport(clause.namedBindings)
        && clause.namedBindings.name.text === name) return clause.namedBindings.name;
      if (clause.namedBindings && tsApi.isNamedImports(clause.namedBindings)) {
        const found = clause.namedBindings.elements.find((element) => !element.isTypeOnly && element.name.text === name)?.name;
        if (found) return found;
      }
    }
  }
  return undefined;
}

function isClassExtends(node: TS.Node): boolean {
  const parent = node.parent;
  if (!parent || !tsApi.isExpressionWithTypeArguments(parent) || parent.expression !== node) return false;
  const clause = parent.parent;
  return tsApi.isHeritageClause(clause) && clause.token === tsApi.SyntaxKind.ExtendsKeyword
    && (tsApi.isClassDeclaration(clause.parent) || tsApi.isClassExpression(clause.parent));
}

function inTypePosition(node: TS.Node): boolean {
  if (isClassExtends(node)) return false;
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (tsApi.isTypeNode(parent)) return true;
  }
  return false;
}

/**
 * A reference wires an export only when the value is consumed: invoked, passed,
 * registered, rendered, read from, returned or extended. A bare reference
 * (`void fresh`, `fresh;`, `const alias = fresh`) does not.
 */
function isConsumingReference(node: TS.Expression): boolean {
  let expression: TS.Node = node;
  while (expression.parent && (tsApi.isParenthesizedExpression(expression.parent) || tsApi.isNonNullExpression(expression.parent)
    || tsApi.isAsExpression(expression.parent) || tsApi.isSatisfiesExpression(expression.parent)
    || tsApi.isTypeAssertionExpression(expression.parent))) expression = expression.parent;
  const parent = expression.parent;
  if (!parent) return false;
  if (isClassExtends(expression)) return true;
  if (tsApi.isCallExpression(parent) || tsApi.isNewExpression(parent)) {
    return parent.expression === expression || !!parent.arguments?.some((argument) => argument === expression);
  }
  if (tsApi.isTaggedTemplateExpression(parent)) return parent.tag === expression;
  if (tsApi.isJsxOpeningElement(parent) || tsApi.isJsxSelfClosingElement(parent)) return parent.tagName === expression;
  if (tsApi.isPropertyAccessExpression(parent) || tsApi.isElementAccessExpression(parent)) return parent.expression === expression;
  if (tsApi.isSpreadElement(parent) || tsApi.isArrayLiteralExpression(parent) || tsApi.isShorthandPropertyAssignment(parent)
    || tsApi.isJsxExpression(parent) || tsApi.isDecorator(parent) || tsApi.isReturnStatement(parent)) return true;
  if (tsApi.isPropertyAssignment(parent)) return parent.initializer === expression;
  if (tsApi.isArrowFunction(parent)) return parent.body === expression;
  return false;
}

function hasBindingUse(source: TS.SourceFile, binding: TS.Identifier): boolean {
  const checker = checkerFor(source);
  const symbol = checker.getSymbolAtLocation(binding);
  if (!symbol) return false;
  let used = false;
  const visit = (node: TS.Node): void => {
    if (used) return;
    if (tsApi.isIdentifier(node) && node !== binding) {
      const parent = node.parent;
      // Declarations, export lists and property keys do not consume a value.
      if (!(('name' in parent) && parent.name === node && !tsApi.isShorthandPropertyAssignment(parent))
        && !tsApi.isImportSpecifier(parent)
        && !tsApi.isImportClause(parent)
        && !tsApi.isNamespaceImport(parent)
        && !tsApi.isExportSpecifier(parent)
        && !(tsApi.isPropertyAccessExpression(parent) && parent.name === node)
        && !(tsApi.isPropertyAssignment(parent) && parent.name === node)
        && !inTypePosition(node)
        && checker.getSymbolAtLocation(node) === symbol
        && isConsumingReference(node)) used = true;
    }
    tsApi.forEachChild(node, visit);
  };
  visit(source);
  return used;
}

function resolvesTo(importer: string, specifier: string, target: string, available: ReadonlySet<string>, cwd: string): boolean {
  if (!specifier.startsWith('.')) return false;
  const base = relative(cwd, resolve(cwd, dirname(importer), specifier)).split(sep).join('/');
  return importCandidates(base).find((candidate) => available.has(candidate)) === target;
}

function consumesExport(source: TS.SourceFile, importer: string, target: string, name: string, available: ReadonlySet<string>, cwd: string): boolean {
  for (const statement of source.statements) {
    if (!tsApi.isImportDeclaration(statement) || !tsApi.isStringLiteral(statement.moduleSpecifier)
      || !resolvesTo(importer, statement.moduleSpecifier.text, target, available, cwd)) continue;
    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly) continue;
    if (name === 'default' && clause.name && hasBindingUse(source, clause.name)) return true;
    const bindings = clause.namedBindings;
    if (bindings && tsApi.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if (element.isTypeOnly || (element.propertyName ?? element.name).text !== name) continue;
        if (hasBindingUse(source, element.name)) return true;
      }
    }
    if (bindings && tsApi.isNamespaceImport(bindings)) {
      const checker = checkerFor(source);
      const namespaceSymbol = checker.getSymbolAtLocation(bindings.name);
      let used = false;
      const visit = (node: TS.Node): void => {
        if (used) return;
        if (tsApi.isPropertyAccessExpression(node) && tsApi.isIdentifier(node.expression)
          && node.name.text === name && !inTypePosition(node)
          && checker.getSymbolAtLocation(node.expression) === namespaceSymbol
          && isConsumingReference(node)) used = true;
        tsApi.forEachChild(node, visit);
      };
      visit(source);
      if (used) return true;
    }
  }
  return false;
}

/** Advisory only: absence is a warning, because dynamic registration can escape static import analysis. */
export function findUnwiredExports(input: WiringCheckInput): WiringCheckResult {
  const cwd = resolve(input.cwd);
  const readFile = input.readFile ?? ((file: string) => readFileSync(file, 'utf8'));
  const candidates: { file: string; name: string; localName: string | null }[] = [];
  const parsedChanged = new Map<string, TS.SourceFile>();
  try {
    for (const file of [...new Set(input.changedFiles)]) {
      if (!SOURCE.test(file) || TEST.test(file) || ENTRYPOINT.test(file)) continue;
      let content: string;
      try { content = readFile(join(cwd, file)); }
      catch (cause) {
        // A file deleted by the run has no current exports to wire; any other read error stays a failure.
        if ((cause as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw cause;
      }
      const current = sourceFile(join(cwd, file), content);
      const base = input.readBaseFile(file);
      const old = base === undefined ? new Map<string, string | null>() : exportedValues(sourceFile(join(cwd, file), base));
      parsedChanged.set(file, current);
      for (const [name, localName] of exportedValues(current)) {
        if (!old.has(name)) candidates.push({ file, name, localName });
      }
    }
    if (candidates.length === 0) return { checked: 0, unwired: [] };
    const files = [...new Set((input.listFiles ?? productionFiles)(cwd))];
    const available = new Set(files);
    const unresolved = candidates.filter(({ file, localName }) => {
      if (localName === null) return true;
      const source = parsedChanged.get(file)!;
      const binding = bindingIdentifier(source, localName);
      return !binding || !hasBindingUse(source, binding);
    });
    const imported = new Set<string>();
    for (const importer of files) {
      if (TEST.test(importer) || unresolved.every(({ file }) => file === importer)) continue;
      const content = readFile(join(cwd, importer));
      if (!content.includes('import')) continue;
      const source = sourceFile(join(cwd, importer), content);
      for (const { file, name } of unresolved) {
        if (file !== importer && consumesExport(source, importer, file, name, available, cwd)) imported.add(`${file}\0${name}`);
      }
    }
    return {
      checked: candidates.length,
      unwired: unresolved.filter(({ file, name }) => !imported.has(`${file}\0${name}`))
        .map(({ file, name }) => ({ file, name, reason: 'no-production-importer' as const })),
    };
  } catch (cause) {
    return { checked: candidates.length, unwired: [], failure: cause instanceof Error ? cause.message : String(cause) };
  }
}
