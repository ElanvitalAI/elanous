import { execFileSync } from 'node:child_process';
import { builtinModules } from 'node:module';
import { isAbsolute, relative, resolve, sep, posix } from 'node:path';
import ts from 'typescript';

export interface ReleaseFailureAttribution {
  readonly failureId: string;
  readonly testFile: string;
  readonly sourceFiles: readonly string[];
  readonly causePrs: readonly number[];
  readonly unresolvedImports: readonly string[];
  readonly confidence: 'high' | 'ambiguous' | 'unmeasured';
  readonly method: 'first-parent-source-overlap' | 'unmeasured';
  readonly evidence: readonly { readonly commit: string; readonly subject: string; readonly files: readonly string[] }[];
}

export interface AttributeReleaseFailuresInput {
  readonly repo: string;
  readonly previousTag: string;
  readonly cutCommit: string;
  readonly failureIds: readonly string[];
}

type Git = (repo: string, args: readonly string[]) => string;

const TEST_FILE_RE = /\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const BUILTINS = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`), 'bun:test']);

function git(repo: string, args: readonly string[]): string {
  return execFileSync('git', [...args], { cwd: repo, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'] }).trimEnd();
}

function repositoryPath(path: string): boolean {
  return path !== '' && !path.startsWith('/') && !path.split('/').includes('..');
}

function readAt(repo: string, commit: string, path: string, runGit: Git): string | undefined {
  try { return runGit(repo, ['show', `${commit}:${path}`]); }
  catch { return undefined; }
}

function importTargets(path: string, text: string): string[] {
  const found = new Set<string>();
  const kind = path.endsWith('.tsx') ? ts.ScriptKind.TSX : path.endsWith('.jsx') ? ts.ScriptKind.JSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier
      && ts.isStringLiteralLike(node.moduleSpecifier)) found.add(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteralLike(node.arguments[0]!)
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) found.add(node.arguments[0]!.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...found];
}

function resolveRelativeImport(repo: string, commit: string, importer: string, specifier: string, runGit: Git): string | undefined {
  const base = posix.normalize(posix.join(posix.dirname(importer), specifier));
  const candidates = /\.[cm]?[jt]sx?$/.test(base)
    ? [base, base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx')]
    : [`${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}/index.ts`, `${base}/index.tsx`];
  return candidates.find((candidate) => repositoryPath(candidate) && readAt(repo, commit, candidate, runGit) !== undefined);
}

interface WorkspacePackage {
  readonly path: string;
  readonly manifest: Record<string, unknown>;
}

function repositoryFiles(repo: string, commit: string, runGit: Git): string[] {
  return runGit(repo, ['ls-tree', '-r', '--name-only', commit]).split(/\r?\n/).filter(Boolean);
}

function repositoryPackages(repo: string, commit: string, files: readonly string[], runGit: Git): Map<string, WorkspacePackage | null> {
  const packages = new Map<string, WorkspacePackage | null>();
  for (const path of files.filter((file) => file.endsWith('/package.json') || file === 'package.json')) {
    try {
      const manifest = JSON.parse(runGit(repo, ['show', `${commit}:${path}`])) as Record<string, unknown>;
      if (typeof manifest.name === 'string' && manifest.name.trim()) {
        if (packages.has(manifest.name)) packages.set(manifest.name, null);
        else packages.set(manifest.name, { path, manifest });
      }
    } catch { /* malformed package manifests are not usable as attribution evidence */ }
  }
  return packages;
}

function sourceCandidates(path: string): string[] {
  const normalized = posix.normalize(path);
  if (normalized.endsWith('.js')) {
    // NodeNext extension substitution probes TS/declaration files before `.js` for `.js` specifiers.
    return [normalized.replace(/\.js$/, '.ts'), normalized.replace(/\.js$/, '.tsx'), normalized.replace(/\.js$/, '.d.ts'), normalized];
  }
  if (normalized.endsWith('.mjs')) {
    return [normalized.replace(/\.mjs$/, '.mts'), normalized.replace(/\.mjs$/, '.d.mts'), normalized];
  }
  if (normalized.endsWith('.cjs')) {
    return [normalized.replace(/\.cjs$/, '.cts'), normalized.replace(/\.cjs$/, '.d.cts'), normalized];
  }
  return /\.[cm]?[jt]sx?$/.test(normalized)
    ? [normalized]
    : [`${normalized}.ts`, `${normalized}.tsx`, `${normalized}.mts`, `${normalized}.js`, `${normalized}/index.ts`, `${normalized}/index.tsx`, `${normalized}/src/index.ts`];
}

function packageExportTarget(exportsValue: unknown, subpath: string): string | undefined {
  if (typeof exportsValue === 'string' && subpath === '.') return exportsValue;
  if (!exportsValue || typeof exportsValue !== 'object' || Array.isArray(exportsValue)) return undefined;
  const exportsObject = exportsValue as Record<string, unknown>;
  let selected: unknown = exportsObject;
  let wildcardCapture: string | undefined;
  if (Object.keys(exportsObject).some((key) => key.startsWith('.'))) {
    selected = exportsObject[subpath];
    if (selected === undefined) {
      let bestPrefixLength = -1;
      for (const [pattern, value] of Object.entries(exportsObject)) {
        const star = pattern.indexOf('*');
        if (star < 0) continue;
        const prefix = pattern.slice(0, star); const suffix = pattern.slice(star + 1);
        if (prefix.length > bestPrefixLength && subpath.startsWith(prefix) && subpath.endsWith(suffix)) {
          // Follow TypeScript/Node-style specificity: the matching export with the longest prefix wins.
          bestPrefixLength = prefix.length;
          wildcardCapture = subpath.slice(prefix.length, suffix ? subpath.length - suffix.length : undefined);
          selected = value;
        }
      }
    }
  } else if (subpath !== '.') return undefined;
  const conditions = (value: unknown): string | undefined => {
    if (typeof value === 'string') return value;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const map = value as Record<string, unknown>;
    for (const key of ['source', 'import', 'default', 'require']) {
      const target = conditions(map[key]);
      if (target) return target;
    }
    return undefined;
  };
  const resolved = conditions(selected);
  return resolved && wildcardCapture !== undefined ? resolved.replaceAll('*', wildcardCapture) : resolved;
}

function resolveWorkspaceImport(repo: string, commit: string, specifier: string,
  packages: ReadonlyMap<string, WorkspacePackage | null>, runGit: Git): { matched: boolean; target?: string } {
  const parts = specifier.split('/');
  const packageName = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
  if (!packages.has(packageName)) return { matched: false };
  const workspace = packages.get(packageName);
  if (!workspace) return { matched: true };
  const manifest = workspace.manifest;
  const packageDir = posix.dirname(workspace.path);
  const suffix = specifier.slice(packageName.length).replace(/^\//, '');
  let target: string | undefined;
  if (suffix) {
    if (manifest.exports !== undefined) target = packageExportTarget(manifest.exports, `./${suffix}`);
    else target = `./${suffix}`;
  } else {
    target = packageExportTarget(manifest.exports, '.')
      ?? [manifest.source, manifest.module, manifest.main].find((value): value is string => typeof value === 'string');
    if (!target && manifest.exports === undefined) target = 'src/index.ts';
  }
  if (!target || target.startsWith('/')) return { matched: true };
  const base = posix.normalize(posix.join(packageDir, target));
  const packagePrefix = packageDir === '.' ? '' : `${packageDir}/`;
  const resolved = sourceCandidates(base).find((candidate) => repositoryPath(candidate)
    && (packagePrefix === '' || candidate.startsWith(packagePrefix)) && readAt(repo, commit, candidate, runGit) !== undefined);
  return resolved ? { matched: true, target: resolved } : { matched: true };
}

function absoluteRepoPath(repo: string, candidate: string): string | undefined {
  const rel = relative(resolve(repo), resolve(candidate)).split(sep).join('/');
  return rel === '' ? '.' : repositoryPath(rel) ? rel : undefined;
}

function resolutionHost(repo: string, commit: string, files: readonly string[], runGit: Git): ts.ModuleResolutionHost & ts.ParseConfigFileHost {
  const fileSet = new Set(files);
  const directorySet = new Set<string>();
  for (const file of files) {
    let directory = posix.dirname(file);
    while (directory !== '.' && directory !== '') { directorySet.add(directory); directory = posix.dirname(directory); }
  }
  const cache = new Map<string, string | undefined>();
  const toRepoPath = (candidate: string): string | undefined => absoluteRepoPath(repo, candidate);
  const readFile = (candidate: string): string | undefined => {
    const path = toRepoPath(candidate);
    if (!path || !fileSet.has(path)) return undefined;
    if (!cache.has(path)) cache.set(path, readAt(repo, commit, path, runGit));
    return cache.get(path);
  };
  const directoryExists = (candidate: string): boolean => {
    const path = toRepoPath(candidate);
    return path !== undefined && (path === '.' || directorySet.has(path));
  };
  const getDirectories = (candidate: string): string[] => {
    const path = toRepoPath(candidate);
    if (!path) return [];
    const prefix = path === '.' ? '' : `${path}/`;
    return [...new Set(files.filter((file) => file.startsWith(prefix)).map((file) => file.slice(prefix.length).split('/'))
      .filter((parts) => parts.length > 1).map((parts) => parts[0]!))];
  };
  const readDirectory = (root: string, extensions?: readonly string[], _excludes?: readonly string[], _includes?: readonly string[], depth?: number): string[] => {
    const path = toRepoPath(root);
    if (!path) return [];
    const prefix = path === '.' ? '' : `${path}/`;
    return files.filter((file) => file.startsWith(prefix)
      && (depth === undefined || file.slice(prefix.length).split('/').length <= depth + 1)
      && (!extensions?.length || extensions.some((extension) => file.endsWith(extension)))).map((file) => resolve(repo, file));
  };
  return { fileExists: (candidate) => { const path = toRepoPath(candidate); return path !== undefined && fileSet.has(path); },
    readFile, directoryExists, getDirectories, readDirectory, getCurrentDirectory: () => resolve(repo),
    realpath: (candidate) => resolve(candidate), useCaseSensitiveFileNames: true,
    onUnRecoverableConfigFileDiagnostic: () => undefined };
}

function testCompilerOptions(repo: string, importer: string, host: ts.ModuleResolutionHost & ts.ParseConfigFileHost,
  files: ReadonlySet<string>, cache: Map<string, ts.CompilerOptions | undefined>): ts.CompilerOptions | undefined {
  let directory = posix.dirname(importer);
  let config = '';
  while (directory !== '.' && directory !== '') {
    const candidate = posix.join(directory, 'tsconfig.json');
    if (files.has(candidate)) { config = candidate; break; }
    const parent = posix.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  if (!config && files.has('tsconfig.json')) config = 'tsconfig.json';
  const cacheKey = config || '<default-options>';
  if (cache.has(cacheKey)) return cache.get(cacheKey);
  if (!config) {
    const defaults = ts.getDefaultCompilerOptions();
    cache.set(cacheKey, defaults);
    return defaults;
  }
  const parsed = ts.getParsedCommandLineOfConfigFile(resolve(repo, config), {}, host);
  const options = !parsed || parsed.errors.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
    ? undefined : parsed.options;
  cache.set(cacheKey, options);
  return options;
}

function pathMappingForSpecifier(options: ts.CompilerOptions, specifier: string): { pattern: string; mappings: readonly string[]; capture?: string } | undefined {
  const entries = Object.entries(options.paths ?? {});
  const exact = entries.find(([pattern]) => !pattern.includes('*') && pattern === specifier);
  if (exact) return { pattern: exact[0], mappings: exact[1] };
  let best: { pattern: string; mappings: readonly string[]; capture: string; prefixLength: number } | undefined;
  for (const [pattern, mappings] of entries) {
    const star = pattern.indexOf('*');
    if (star < 0) continue;
    const prefix = pattern.slice(0, star); const suffix = pattern.slice(star + 1);
    if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue;
    const candidate = { pattern, mappings, capture: specifier.slice(prefix.length, suffix ? specifier.length - suffix.length : undefined),
      prefixLength: prefix.length };
    // TypeScript keeps declaration order when matching patterns have equal prefix lengths.
    if (!best || candidate.prefixLength > best.prefixLength) best = candidate;
  }
  return best;
}

function pathAliasMatches(options: ts.CompilerOptions, specifier: string): boolean {
  return pathMappingForSpecifier(options, specifier) !== undefined;
}

function resolvePathAlias(repo: string, commit: string, specifier: string, options: ts.CompilerOptions,
  runGit: Git): { matched: boolean; target?: string } {
  const match = pathMappingForSpecifier(options, specifier);
  if (!match) return { matched: false };
  const pathBase = (options as ts.CompilerOptions & { pathsBasePath?: string }).pathsBasePath ?? options.baseUrl ?? repo;
  const relativeBase = absoluteRepoPath(repo, isAbsolute(pathBase) ? pathBase : resolve(repo, pathBase));
  if (relativeBase === undefined) return { matched: true };
  for (const mapping of match.mappings) {
    const mapped = match.capture === undefined ? mapping : mapping.replace('*', match.capture);
    const target = posix.normalize(posix.join(relativeBase, mapped));
    const found = sourceCandidates(target).find((candidate) => repositoryPath(candidate)
      && readAt(repo, commit, candidate, runGit) !== undefined);
    if (found) return { matched: true, target: found };
  }
  return { matched: true };
}

function declaredExternal(repo: string, commit: string, importer: string, specifier: string, files: ReadonlySet<string>, runGit: Git): boolean {
  const parts = specifier.split('/');
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
  let directory = posix.dirname(importer);
  while (true) {
    const manifestPath = directory === '.' ? 'package.json' : posix.join(directory, 'package.json');
    if (files.has(manifestPath)) {
      try {
        const manifest = JSON.parse(readAt(repo, commit, manifestPath, runGit) ?? '') as Record<string, Record<string, string>>;
        const version = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']
          .map((section) => manifest[section]?.[name]).find((value) => typeof value === 'string');
        if (version !== undefined) return !/^(?:workspace:|file:|link:)/.test(version);
      } catch { return false; }
    }
    if (directory === '.') break;
    const parent = posix.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return false;
}

function sourceClosure(repo: string, commit: string, testFile: string, runGit: Git): { files: string[]; unresolved: string[] } {
  const visited = new Set<string>([testFile]);
  const sources = new Set<string>();
  const unresolved = new Set<string>();
  const files = repositoryFiles(repo, commit, runGit);
  const packages = repositoryPackages(repo, commit, files, runGit);
  const moduleHost = resolutionHost(repo, commit, files, runGit);
  const fileSet = new Set(files);
  const optionsCache = new Map<string, ts.CompilerOptions | undefined>();
  const pending = [testFile];
  while (pending.length) {
    const importer = pending.pop()!;
    const text = readAt(repo, commit, importer, runGit);
    if (text === undefined) continue;
    for (const specifier of importTargets(importer, text)) {
      if (!specifier.startsWith('.')) {
        if (BUILTINS.has(specifier) || specifier.startsWith('node:') && BUILTINS.has(specifier)) continue;
        const options = testCompilerOptions(repo, importer, moduleHost, fileSet, optionsCache);
        if (!options) { unresolved.add(`${importer} -> ${specifier}`); continue; }
        const isAlias = pathAliasMatches(options, specifier);
        const follow = (target: string) => {
          if (visited.has(target)) return;
          visited.add(target);
          if (!TEST_FILE_RE.test(target)) sources.add(target);
          pending.push(target);
        };
        if (isAlias) {
          const alias = resolvePathAlias(repo, commit, specifier, options, runGit);
          if (alias.target) { follow(alias.target); continue; }
        }
        const resolved = ts.resolveModuleName(specifier, resolve(repo, importer), options, moduleHost).resolvedModule?.resolvedFileName;
        const internalPath = resolved ? absoluteRepoPath(repo, resolved) : undefined;
        if (internalPath && files.includes(internalPath)) follow(internalPath);
        else {
          const workspace = resolveWorkspaceImport(repo, commit, specifier, packages, runGit);
          if (workspace.target) follow(workspace.target);
          else if (workspace.matched || !declaredExternal(repo, commit, importer, specifier, fileSet, runGit)) {
            unresolved.add(`${importer} -> ${specifier}`);
          }
        }
        continue;
      }
      const target = resolveRelativeImport(repo, commit, importer, specifier, runGit);
      if (!target) { unresolved.add(`${importer} -> ${specifier}`); continue; }
      if (visited.has(target)) continue;
      visited.add(target);
      if (!TEST_FILE_RE.test(target)) sources.add(target);
      pending.push(target);
    }
  }
  return { files: [...sources].sort(), unresolved: [...unresolved].sort() };
}

function failuresOf(ids: readonly string[]): { testFile: string; failureId: string }[] {
  const result: { testFile: string; failureId: string }[] = [];
  for (const id of ids) {
    const separator = id.indexOf(' > ');
    const file = (separator < 0 ? id : id.slice(0, separator)).trim();
    const valid = repositoryPath(file) && TEST_FILE_RE.test(file);
    result.push({ testFile: valid ? file : '', failureId: id });
  }
  return result.sort((left, right) => left.failureId.localeCompare(right.failureId));
}

/** Attribute introduced gate failures to production sources and first-parent PR commits, never to the test file itself. */
export function attributeReleaseFailures(input: AttributeReleaseFailuresInput, runGit: Git = git): ReleaseFailureAttribution[] {
  if (!input.repo.trim() || !input.previousTag.trim() || !input.cutCommit.trim()) throw new Error('repo, previous release tag, and cut commit are required');
  const failures = failuresOf(input.failureIds);
  if (failures.length === 0) return [];
  let commits: string[];
  try {
    const previousCommit = runGit(input.repo, ['rev-parse', '--verify', `${input.previousTag}^{commit}`]);
    const firstParentHistory = runGit(input.repo, ['rev-list', '--first-parent', input.cutCommit]).split(/\r?\n/);
    if (!firstParentHistory.includes(previousCommit)) {
      return failures.map(({ testFile, failureId }) => ({ failureId, testFile, sourceFiles: [], causePrs: [],
        unresolvedImports: [], confidence: 'unmeasured', method: 'unmeasured', evidence: [] }));
    }
    commits = runGit(input.repo, ['rev-list', '--first-parent', '--reverse', `${previousCommit}..${input.cutCommit}`]).split(/\r?\n/).filter(Boolean);
  } catch {
    return failures.map(({ testFile, failureId }) => ({ failureId, testFile, sourceFiles: [], causePrs: [],
      unresolvedImports: [], confidence: 'unmeasured', method: 'unmeasured', evidence: [] }));
  }
  const commitEvidence = commits.map((commit) => {
    const subject = runGit(input.repo, ['show', '-s', '--format=%s', commit]);
    const parent = runGit(input.repo, ['rev-parse', `${commit}^`]);
    const files = runGit(input.repo, ['diff', '--name-only', parent, commit]).split(/\r?\n/).filter(Boolean).sort();
    const pr = /(?:\(#(\d+)\)|\bPR\s+#(\d+)\b)/i.exec(subject);
    return { commit, subject, files, prNumber: Number(pr?.[1] ?? pr?.[2]) || undefined };
  });
  return failures.map(({ testFile, failureId }) => {
    if (!testFile) return { failureId, testFile, sourceFiles: [], causePrs: [],
      unresolvedImports: [`invalid test failure id: ${failureId}`], confidence: 'unmeasured' as const,
      method: 'unmeasured' as const, evidence: [] };
    const closure = sourceClosure(input.repo, input.cutCommit, testFile, runGit);
    const sourceFiles = closure.files;
    const sourceSet = new Set(sourceFiles);
    const evidence = commitEvidence.filter((commit) => commit.files.some((file) => sourceSet.has(file)))
      .map(({ commit, subject, files }) => ({ commit, subject, files }));
    const overlappingCommits = commitEvidence.filter((commit) => commit.files.some((file) => sourceSet.has(file)));
    const causePrs = [...new Set(overlappingCommits.filter((commit) => commit.prNumber !== undefined
      && commit.files.some((file) => sourceSet.has(file))).map((commit) => commit.prNumber!))].sort((a, b) => a - b);
    const confidence = closure.unresolved.length > 0 || causePrs.length === 0
      || overlappingCommits.some((commit) => commit.prNumber === undefined) ? 'unmeasured'
      : causePrs.length === 1 ? 'high' : 'ambiguous';
    return { failureId, testFile, sourceFiles, causePrs, unresolvedImports: closure.unresolved, confidence,
      method: confidence === 'unmeasured' ? 'unmeasured' : 'first-parent-source-overlap', evidence };
  });
}
