import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';

const ts = createRequire(import.meta.url)('typescript') as typeof import('typescript');

export type NextTuiBudgetMetric = { files: number; lines: number };
export type NextTuiRuntimeClosure = { files: string[]; metric: NextTuiBudgetMetric };

/** These ordered screen markers distinguish the input-ready TUI frame from incidental startup text. */
export const NEXT_TUI_READY_SCREEN_MARKERS = ['Enter 전송', 'Esc 취소', 'Ctrl+Q 종료', '❯'] as const;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** Tcl/expect pattern used by the startup probe; a screen clear begins each rendered frame. */
const FRAME_CLEAR_TCL_REGEX = '\\x1b\\[H\\x1b\\[2J';
const WITHIN_FRAME_TCL_REGEX = `(?:(?!${FRAME_CLEAR_TCL_REGEX}).)*`;
export const NEXT_TUI_READY_SCREEN_TCL_REGEX = `(?s)${FRAME_CLEAR_TCL_REGEX}${WITHIN_FRAME_TCL_REGEX}${NEXT_TUI_READY_SCREEN_MARKERS.map(escapeRegex).join(WITHIN_FRAME_TCL_REGEX)}`;

/** The real TUI frame has the complete idle status and input prompt, in that order. */
export function isNextTuiReadyScreen(screen: string): boolean {
  const plain = screen.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '');
  let offset = 0;
  for (const marker of NEXT_TUI_READY_SCREEN_MARKERS) {
    const found = plain.indexOf(marker, offset);
    if (found < 0) return false;
    offset = found + marker.length;
  }
  return true;
}

function isTypeOnlyRuntimeEdge(node: import('typescript').ImportDeclaration | import('typescript').ExportDeclaration): boolean {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;
    if (!clause) return false;
    if (clause.isTypeOnly) return true;
    if (clause.name) return false;
    return clause.namedBindings !== undefined
      && ts.isNamedImports(clause.namedBindings)
      && clause.namedBindings.elements.length > 0
      && clause.namedBindings.elements.every((specifier) => specifier.isTypeOnly);
  }
  if (node.isTypeOnly) return true;
  return node.exportClause !== undefined
    && ts.isNamedExports(node.exportClause)
    && node.exportClause.elements.length > 0
    && node.exportClause.elements.every((specifier) => specifier.isTypeOnly);
}

function comparePathPatterns(a: string, b: string): number {
  const aStar = a.indexOf('*');
  const bStar = b.indexOf('*');
  const aPrefixLength = aStar < 0 ? a.length : aStar + 1;
  const bPrefixLength = bStar < 0 ? b.length : bStar + 1;
  if (aPrefixLength !== bPrefixLength) return bPrefixLength - aPrefixLength;
  if (aStar < 0) return 1;
  if (bStar < 0) return -1;
  return b.length - a.length;
}

/** Resolve the TypeScript paths pattern that wins by longest prefix, then longest pattern. */
function orderedPathMappings(paths: Record<string, readonly string[]>): Array<[string, readonly string[]]> {
  const exact = Object.entries(paths).filter(([pattern]) => !pattern.includes('*'));
  const patterns = Object.entries(paths).filter(([pattern]) => pattern.includes('*')).sort(([a], [b]) => comparePathPatterns(a, b));
  return [...exact, ...patterns];
}

/** Walk the runtime static import closure using the project's TypeScript paths mapping rules. */
export function collectNextTuiRuntimeClosure(
  projectRoot: string,
  entryRelativePath = 'src/tui/entry.ts',
): NextTuiRuntimeClosure {
  const root = resolve(projectRoot);
  const repoRealPath = realpathSync(root);
  const entry = resolve(root, entryRelativePath);
  const tsconfig = ts.readConfigFile(join(root, 'tsconfig.json'), ts.sys.readFile);
  if (tsconfig.error) throw new Error(ts.flattenDiagnosticMessageText(tsconfig.error.messageText, '\n'));
  const compilerOptions = ts.parseJsonConfigFileContent(tsconfig.config, ts.sys, root).options;

  const allowedPath = (path: string): boolean => {
    let actual = path;
    try { actual = realpathSync(path); } catch { /* use normalized target before it exists */ }
    const rel = relative(repoRealPath, actual);
    return rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.split(sep).includes('node_modules');
  };
  const allowedFile = (path: string): boolean => allowedPath(path)
    && (extname(path) === '' || /\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/u.test(path))
    && !/\.d\.(?:ts|mts|cts)$/u.test(path);
  const fileAt = (path: string): string | undefined => {
    try { return existsSync(path) && statSync(path).isFile() && allowedFile(path) ? path : undefined; } catch { return undefined; }
  };
  const entryCandidates = (path: string): string[] => {
    const ext = extname(path);
    if (ext === '.js') return [path, path.slice(0, -3) + '.ts', path.slice(0, -3) + '.tsx'];
    if (ext === '.mjs') return [path, path.slice(0, -4) + '.mts'];
    if (ext === '.cjs') return [path, path.slice(0, -4) + '.cts'];
    if (ext === '.jsx') return [path, path.slice(0, -4) + '.tsx'];
    if (ext) return [path];
    return [path, ...['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.jsx'].map((suffix) => path + suffix)];
  };
  const exportTargets = (value: unknown): string[] => {
    if (typeof value === 'string') return [value];
    if (Array.isArray(value)) return value.flatMap(exportTargets);
    if (!value || typeof value !== 'object') return [];
    const row = value as Record<string, unknown>;
    if (row['.'] !== undefined) return exportTargets(row['.']);
    return ['bun', 'import', 'node', 'default'].flatMap((condition) => row[condition] === undefined ? [] : exportTargets(row[condition]));
  };
  const packageEntries = (directory: string): string[] => {
    const manifest = join(directory, 'package.json');
    if (!existsSync(manifest)) return [];
    try {
      const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as Record<string, unknown>;
      return [...exportTargets(pkg.exports), ...['bun', 'module', 'main'].flatMap((key) => typeof pkg[key] === 'string' ? [pkg[key] as string] : [])]
        .map((target) => resolve(directory, target));
    } catch { return []; }
  };
  const resolveRuntimePath = (path: string, seen = new Set<string>()): string | undefined => {
    const absolute = resolve(path);
    if (seen.has(absolute) || !allowedPath(absolute)) return undefined;
    seen.add(absolute);
    for (const candidate of entryCandidates(absolute)) {
      const file = fileAt(candidate);
      if (file) return file;
    }
    try {
      if (!statSync(absolute).isDirectory()) return undefined;
    } catch { return undefined; }
    for (const target of packageEntries(absolute)) {
      const resolved = resolveRuntimePath(target, seen);
      if (resolved) return resolved;
    }
    for (const name of ['index', 'index.ts', 'index.tsx', 'index.mts', 'index.cts', 'index.js', 'index.mjs', 'index.cjs', 'index.jsx']) {
      const file = fileAt(join(absolute, name));
      if (file) return file;
    }
    return undefined;
  };
  const resolveLocalImport = (from: string, specifier: string): string | undefined => {
    const typescriptResolution = ts.resolveModuleName(specifier, from, compilerOptions, ts.sys).resolvedModule?.resolvedFileName;
    if (typescriptResolution) return fileAt(typescriptResolution);
    if (specifier.startsWith('.')) return resolveRuntimePath(resolve(dirname(from), specifier));
    const rawCompilerOptions = tsconfig.config.compilerOptions as { paths?: Record<string, string[]> } | undefined;
    const paths = (compilerOptions.paths ?? rawCompilerOptions?.paths ?? {}) as Record<string, string[]>;
    const baseUrl = compilerOptions.baseUrl ?? root;
    for (const [pattern, substitutions] of orderedPathMappings(paths)) {
      const star = pattern.indexOf('*');
      let capture: string | undefined;
      if (star < 0) {
        if (specifier === pattern) capture = '';
      } else {
        const prefix = pattern.slice(0, star);
        const suffix = pattern.slice(star + 1);
        if (specifier.startsWith(prefix) && specifier.endsWith(suffix) && specifier.length >= prefix.length + suffix.length) {
          capture = specifier.slice(prefix.length, specifier.length - suffix.length);
        }
      }
      if (capture === undefined) continue;
      for (const substitution of substitutions) {
        const target = resolve(baseUrl, substitution.replace('*', capture));
        const resolved = resolveRuntimePath(target);
        if (resolved) return resolved;
      }
    }
    return undefined;
  };

  const visited = new Set<string>();
  const pending = [entry];
  while (pending.length) {
    const file = pending.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    for (const node of source.statements) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
        && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
        && !isTypeOnlyRuntimeEdge(node)) {
        const target = resolveLocalImport(file, node.moduleSpecifier.text);
        if (target) pending.push(target);
      }
    }
  }
  const files = [...visited].sort();
  const lines = files.reduce((total, file) => total + (readFileSync(file, 'utf8').match(/\n/gu)?.length ?? 0), 0);
  return { files, metric: { files: files.length, lines } };
}
