import { execFileSync } from 'node:child_process';
import { builtinModules } from 'node:module';
import { posix } from 'node:path';
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

function resolveImport(repo: string, commit: string, importer: string, specifier: string, runGit: Git): string | undefined {
  const base = posix.normalize(posix.join(posix.dirname(importer), specifier));
  const candidates = /\.[cm]?[jt]sx?$/.test(base)
    ? [base, base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx')]
    : [`${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}/index.ts`, `${base}/index.tsx`];
  return candidates.find((candidate) => repositoryPath(candidate) && readAt(repo, commit, candidate, runGit) !== undefined);
}

function repositoryPackageNames(repo: string, commit: string, runGit: Git): ReadonlySet<string> {
  try {
    const lines = runGit(repo, ['grep', '-h', '-E', '"name"[[:space:]]*:', commit, '--', ':(glob)**/package.json', 'package.json']);
    return new Set([...lines.matchAll(/"name"\s*:\s*"([^"]+)"/g)].map((match) => match[1]!));
  } catch { return new Set(); }
}

function isDeclaredExternal(repo: string, commit: string, specifier: string, runGit: Git,
  packageNames: ReadonlySet<string>): boolean {
  if (BUILTINS.has(specifier)) return true;
  if (specifier.startsWith('node:')) return BUILTINS.has(specifier);
  const parts = specifier.split('/');
  const packageName = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
  if (packageNames.has(packageName)) return false;
  const packageJson = readAt(repo, commit, 'package.json', runGit);
  if (!packageJson) return false;
  try {
    const manifest = JSON.parse(packageJson) as Record<string, Record<string, string>>;
    const declared = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']
      .some((section) => typeof manifest[section]?.[packageName] === 'string'
        && !/^(?:workspace:|file:|link:)/.test(manifest[section]![packageName]!));
    if (!declared) return false;
    const tsconfig = readAt(repo, commit, 'tsconfig.json', runGit);
    if (!tsconfig) return true;
    const parsed = ts.parseConfigFileTextToJson('tsconfig.json', tsconfig);
    const compilerOptions = parsed.config?.compilerOptions as Record<string, unknown> | undefined;
    // Extended configs, baseUrl lookups, and any paths map can redirect a bare import into the repo.
    // Until TypeScript's full config inheritance is resolved at the cut, classify it as unmeasured.
    if (parsed.config?.extends || compilerOptions?.baseUrl || compilerOptions?.paths) return false;
    return true;
  } catch { return false; }
}

function sourceClosure(repo: string, commit: string, testFile: string, runGit: Git): { files: string[]; unresolved: string[] } {
  const visited = new Set<string>([testFile]);
  const sources = new Set<string>();
  const unresolved = new Set<string>();
  const packageNames = repositoryPackageNames(repo, commit, runGit);
  const pending = [testFile];
  while (pending.length) {
    const importer = pending.pop()!;
    const text = readAt(repo, commit, importer, runGit);
    if (text === undefined) continue;
    for (const specifier of importTargets(importer, text)) {
      if (!specifier.startsWith('.')) {
        if (!isDeclaredExternal(repo, commit, specifier, runGit, packageNames))
          unresolved.add(`${importer} -> ${specifier}`);
        continue;
      }
      const target = resolveImport(repo, commit, importer, specifier, runGit);
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
