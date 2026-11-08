import { debug } from '../debug/log.js';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, normalize, resolve } from 'node:path';
import ts from 'typescript';
import { exportedDeclarations } from './pr-land-drift-repair.js';

export interface DriftRadarPullRequest {
  number: number;
  author?: string;
  headSha?: string;
  diff: string;
  sources?: readonly { path: string; content: string }[];
}

export interface DriftRadarResult {
  scanned: number;
  warned: number;
  skipped: number;
}

export function classifyDriftTypecheckResult(input: {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}): { passed: boolean; measured: boolean; output: string } {
  const output = `${input.stdout}\n${input.stderr}\n${input.error?.message ?? ''}`.trim();
  if (input.error || input.status === null) return { passed: false, measured: false, output };
  if (input.status === 0 && /\[tsc-gate\] PASS —/u.test(output)) return { passed: true, measured: true, output };
  if (input.status === 1 && /\[tsc-gate\] FAIL — 타입 에러가 있다/u.test(output)) return { passed: false, measured: true, output };
  return { passed: false, measured: false, output };
}

export interface DriftRadarDeps {
  changedExports: () => readonly string[];
  changedExportPaths?: () => Readonly<Record<string, readonly string[]>>;
  changedModuleFiles?: () => Readonly<Record<string, string>>;
  /** Paths and module metadata as they existed before the landed change. */
  preChangeFiles?: () => Readonly<Record<string, string | null>>;
  repoRoot?: string;
  openPullRequests: () => readonly DriftRadarPullRequest[];
  typecheckOnLatestMain: (pr: number) => { passed: boolean; output: string; measured?: boolean };
  notifyOwner: (pr: number, author: string | undefined, body: string) => boolean;
  observe?: (event: string, data: Record<string, unknown>) => void;
  limit?: number;
  now?: () => number;
}

const compilerOptionsByRoot = new Map<string, ts.CompilerOptions>();

function radarCompilerOptions(repoRoot: string): ts.CompilerOptions {
  const cached = compilerOptionsByRoot.get(repoRoot);
  if (cached) return cached;
  let options: ts.CompilerOptions = {};
  const configPath = ts.findConfigFile(repoRoot, ts.sys.fileExists, 'tsconfig.json');
  if (configPath) {
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    if (!config.error) options = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath)).options;
  }
  compilerOptionsByRoot.set(repoRoot, options);
  return options;
}

/** Export names are intentionally conservative: ambiguous declaration changes are omitted. */
export function changedExportNames(diff: string): string[] {
  const names = new Set<string>();
  let currentFile = '';
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('+++ b/')) currentFile = line.slice(6);
    if (!currentFile.endsWith('.ts') && !currentFile.endsWith('.tsx')) continue;
    if ((!line.startsWith('+') && !line.startsWith('-')) || line.startsWith('+++') || line.startsWith('---')) continue;
    const sign = line[0]!;
    const match = new RegExp(`^\\${sign}\\s*export\\s+(?:(?:declare|abstract)\\s+)*(?:default\\s+)?(?:const|let|var|function|class|interface|type|enum|namespace)\\s+([$\\w]+)`).exec(line);
    if (match) names.add(match[1]!);
    for (const exports of line.matchAll(new RegExp(`^\\${sign}\\s*export\\s*\\{([^}]*)\\}`, 'g'))) {
      for (const item of exports[1]!.split(',')) {
        const tokens = item.trim().split(/\s+as\s+/);
        const exported = tokens.at(-1)?.trim();
        if (exported && /^[$\w]+$/.test(exported)) names.add(exported);
      }
    }
  }
  return [...names].sort();
}

export function changedExportsFromSources(files: readonly { path: string; before: string; after: string }[]): { names: string[]; paths: Record<string, string[]> } {
  const paths: Record<string, string[]> = {};
  for (const file of files) {
    const before = exportedDeclarations(file.before);
    const after = exportedDeclarations(file.after);
    for (const name of new Set([...before.keys(), ...after.keys()])) if (before.get(name) !== after.get(name)) {
      (paths[name] ??= []).push(file.path);
    }
  }
  return { names: Object.keys(paths).sort(), paths };
}

export function importsChangedExport(sourceText: string, symbols: readonly string[], changedPaths: Readonly<Record<string, readonly string[]>> = {}, importerPath?: string, repoRoot?: string, changedModuleFiles: Readonly<Record<string, string>> = {}, preChangeFiles: Readonly<Record<string, string | null>> = {}): boolean {
  if (!symbols.length) return false;
  const source = sourceText.replace(/^\+(?=\s*import)/gm, '');
  const parsed = ts.createSourceFile(importerPath ?? 'candidate.ts', source, ts.ScriptTarget.Latest, true,
    importerPath?.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const compilerOptions = repoRoot ? radarCompilerOptions(repoRoot) : {};
  const changedSourcePaths = new Set(Object.values(changedPaths).flat().map((file) => resolve(repoRoot ?? '', file)));
  const moduleFiles = new Map(Object.entries(changedModuleFiles).map(([file, content]) => [resolve(repoRoot ?? '', file), content]));
  const preChangePaths = new Set(Object.keys(preChangeFiles).map((file) => resolve(repoRoot ?? '', file)));
  const originalFiles = new Map(Object.entries(preChangeFiles)
    .filter((entry): entry is [string, string] => entry[1] !== null)
    .map(([file, content]) => [resolve(repoRoot ?? '', file), content]));
  const changedSourceDirectories = new Set<string>();
  for (const file of [...changedSourcePaths, ...moduleFiles.keys(), ...originalFiles.keys()]) {
    let directory = dirname(file);
    while (!changedSourceDirectories.has(directory)) {
      changedSourceDirectories.add(directory);
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  const preChangeResolutionHost: ts.ModuleResolutionHost | undefined = repoRoot ? {
    ...ts.sys,
    // A removed export's source file is absent from the current checkout. Keep its
    // path visible to TypeScript's normal extension and alias resolution so the
    // candidate import can still be associated with the landed deletion.
    fileExists: (fileName) => {
      const absolute = resolve(fileName);
      if (preChangePaths.has(absolute)) return originalFiles.has(absolute) || moduleFiles.has(absolute);
      return changedSourcePaths.has(absolute) || moduleFiles.has(absolute) || ts.sys.fileExists(fileName);
    },
    directoryExists: (directoryName) => changedSourceDirectories.has(resolve(directoryName)) || ts.sys.directoryExists?.(directoryName) === true,
    readFile: (fileName) => {
      const absolute = resolve(fileName);
      if (preChangePaths.has(absolute)) return originalFiles.get(absolute) ?? moduleFiles.get(absolute);
      return moduleFiles.get(absolute) ?? ts.sys.readFile(fileName);
    },
  } : undefined;
  const currentResolutionHost: ts.ModuleResolutionHost | undefined = repoRoot ? ts.sys : undefined;
  for (const statement of parsed.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    const names = bindings.elements.map((element) => element.propertyName?.text ?? element.name.text);
    const affectedSymbols = symbols.filter((symbol) => names.includes(symbol));
    if (!affectedSymbols.length) continue;
    const modulePath = statement.moduleSpecifier.text;
    if (affectedSymbols.some((symbol) => {
      const files = changedPaths[symbol];
      if (!files?.length) return true;
      if (!importerPath) return false;
      return files.some((file) => {
        if (repoRoot) {
          const importer = resolve(repoRoot, importerPath);
          const currentResolved = ts.resolveModuleName(modulePath, importer, compilerOptions, currentResolutionHost!).resolvedModule?.resolvedFileName;
          const previousResolved = ts.resolveModuleName(modulePath, importer, compilerOptions, preChangeResolutionHost!).resolvedModule?.resolvedFileName;
          const expected = resolve(repoRoot, file);
          return [currentResolved, previousResolved].some((resolved) => !!resolved && resolve(resolved) === expected);
        }
        if (!modulePath.startsWith('.')) return false;
        const target = file.replace(/\\/g, '/');
        const resolved = normalize(join(dirname(importerPath), modulePath)).replace(/\\/g, '/');
        const base = resolved.replace(/\.(?:js|jsx|mjs|cjs)$/, '');
        const candidates = [resolved, `${base}.ts`, `${base}.tsx`, `${base}.mts`, `${base}/index.ts`, `${base}/index.tsx`];
        return candidates.includes(target);
      });
    })) return true;
  }
  return false;
}

/** A post-land observation; all external effects are injected and failures never affect landing. */
export function runTypeDriftRadar(deps: DriftRadarDeps): DriftRadarResult {
  const observe = deps.observe ?? ((event, data) => debug.log('pr.land', `drift-radar-${event}`, data));
  const limit = deps.limit ?? 10;
  const symbols = [...new Set(deps.changedExports())].sort();
  if (!symbols.length) {
    observe('skipped', { reason: 'no-exported-symbol-change' });
    return { scanned: 0, warned: 0, skipped: 1 };
  }
  let pulls: readonly DriftRadarPullRequest[];
  try { pulls = deps.openPullRequests(); }
  catch (error) {
    observe('skipped', { reason: 'open-pr-list-unavailable', error: String(error).slice(0, 160) });
    return { scanned: 0, warned: 0, skipped: 1 };
  }
  const changedPaths = deps.changedExportPaths?.() ?? {};
  const changedModuleFiles = deps.changedModuleFiles?.() ?? {};
  const preChangeFiles = deps.preChangeFiles?.() ?? {};
  const candidates = pulls.filter((pr) => pr.sources
    ? pr.sources.some((source) => importsChangedExport(source.content, symbols, changedPaths, source.path, deps.repoRoot, changedModuleFiles, preChangeFiles))
    : importsChangedExport(pr.diff, symbols, changedPaths));
  observe('scanned', { symbols, candidates: Math.min(candidates.length, limit), truncated: candidates.length > limit });
  let warned = 0;
  let skipped = Math.max(0, candidates.length - limit);
  const startedAt = (deps.now ?? Date.now)();
  const limitedCandidates = candidates.slice(0, limit);
  for (const [index, pr] of limitedCandidates.entries()) {
    try {
      if ((deps.now ?? Date.now)() - startedAt >= 15 * 60_000) {
        skipped += limitedCandidates.length - index;
        observe('skipped', { reason: 'time-budget-exhausted', budgetMs: 15 * 60_000 });
        break;
      }
      const check = deps.typecheckOnLatestMain(pr.number);
      if (check.measured === false) {
        skipped += 1;
        observe('skipped', { pr: pr.number, reason: 'typecheck-unmeasured', diagnostic: check.output.slice(0, 240) });
        continue;
      }
      if (check.passed) continue;
      const body = `[TYPE-DRIFT-RADAR] PR #${pr.number}가 main 착지 export(${symbols.join(', ')}) 영향을 받을 수 있습니다. 최신 main 위 원격 타입 검사 실패:\n${check.output.slice(0, 1200)}\n③ LAND-DRIFT-AUTOREPAIR 수리 골로 바로 진행해 주세요.`;
      if (deps.notifyOwner(pr.number, pr.author, body)) {
        warned += 1;
        observe('warned', { pr: pr.number, symbols, author: pr.author ?? null });
      } else {
        skipped += 1;
        observe('skipped', { pr: pr.number, reason: 'owner-notice-failed' });
      }
    } catch (error) {
      skipped += 1;
      observe('skipped', { pr: pr.number, reason: String(error).slice(0, 160) });
    }
  }
  return { scanned: Math.min(candidates.length, limit), warned, skipped };
}

/** Production adapter: use a clean latest-main worktree for each candidate and the remote changed-file gate. */
export function runTypeDriftRadarAfterLanding(input: { cwd: string; mergeCommit: string }): DriftRadarResult {
  const run = (command: string, args: readonly string[], cwd = input.cwd, timeoutMs = 30_000) => spawnSync(command, [...args], {
    cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024,
  });
  const git = (args: readonly string[], cwd = input.cwd) => run('git', args, cwd);
  const fetchMain = git(['fetch', '--quiet', 'origin', 'main']);
  const latestMain = fetchMain.status === 0 ? git(['rev-parse', '--verify', 'origin/main']) : undefined;
  const mainSha = latestMain?.status === 0 ? latestMain.stdout.trim() : '';
  const mergeFetch = git(['fetch', '--quiet', 'origin', input.mergeCommit]);
  if (!/^[a-f0-9]{40}$/i.test(mainSha) || mergeFetch.status !== 0) {
    debug.log('pr.land', 'drift-radar-skipped', { reason: 'latest-main-or-merge-commit-unavailable', mergeCommit: input.mergeCommit });
    return { scanned: 0, warned: 0, skipped: 1 };
  }
  const changedFiles = git(['diff', '--name-only', `${input.mergeCommit}^1`, input.mergeCommit]);
  if (changedFiles.status !== 0) {
    debug.log('pr.land', 'drift-radar-skipped', { reason: 'landed-export-diff-unavailable', mergeCommit: input.mergeCommit });
    return { scanned: 0, warned: 0, skipped: 1 };
  }
  const sourceChanges: { path: string; before: string; after: string }[] = [];
  const changedModuleFiles: Record<string, string> = {};
  const preChangeFiles: Record<string, string | null> = {};
  const changedPathsOnDisk = changedFiles.stdout.split(/\r?\n/).filter(Boolean);
  for (const file of changedPathsOnDisk) {
    const oldSource = git(['show', `${input.mergeCommit}^1:${file}`]);
    const newSource = git(['show', `${input.mergeCommit}:${file}`]);
    preChangeFiles[file] = oldSource.status === 0 ? oldSource.stdout : null;
    if (/\.tsx?$/.test(file)) {
      sourceChanges.push({ path: file, before: oldSource.status === 0 ? oldSource.stdout : '', after: newSource.status === 0 ? newSource.stdout : '' });
    }
    if (/\.tsx?$/.test(file)) {
      let directory = dirname(file);
      while (directory !== '.') {
        const packagePath = join(directory, 'package.json');
        const oldPackage = git(['show', `${input.mergeCommit}^1:${packagePath}`]);
        const newPackage = git(['show', `${input.mergeCommit}:${packagePath}`]);
        if (oldPackage.status === 0 && (newPackage.status !== 0 || oldPackage.stdout !== newPackage.stdout)) {
          changedModuleFiles[packagePath] = oldPackage.stdout;
          preChangeFiles[packagePath] = oldPackage.stdout;
        }
        const parent = dirname(directory);
        if (parent === directory) break;
        directory = parent;
      }
      const rootPackage = git(['show', `${input.mergeCommit}^1:package.json`]);
      const newRootPackage = git(['show', `${input.mergeCommit}:package.json`]);
      if (rootPackage.status === 0 && (newRootPackage.status !== 0 || rootPackage.stdout !== newRootPackage.stdout)) {
        changedModuleFiles['package.json'] = rootPackage.stdout;
        preChangeFiles['package.json'] = rootPackage.stdout;
      }
    }
  }
  const { names: changedNames, paths: changedPaths } = changedExportsFromSources(sourceChanges);
  const symbols = new Set(changedNames);
  if (!symbols.size) {
    debug.log('pr.land', 'drift-radar-skipped', { reason: 'no-exported-symbol-change', mergeCommit: input.mergeCommit });
    return { scanned: 0, warned: 0, skipped: 1 };
  }
  const pulls = run('gh', ['pr', 'list', '--state', 'open', '--limit', '100', '--json', 'number,author,headRefOid']);
  let open: { number: number; author?: { login?: string }; headRefOid?: string }[];
  try { open = pulls.status === 0 ? JSON.parse(pulls.stdout) as typeof open : []; }
  catch { open = []; }
  if (pulls.status !== 0 || !Array.isArray(open)) {
    debug.log('pr.land', 'drift-radar-skipped', { reason: 'open-pr-list-unavailable' });
    return { scanned: 0, warned: 0, skipped: 1 };
  }
  const pullsWithImports = open.map((pr) => {
    const fetched = git(['fetch', '--quiet', 'origin', `pull/${pr.number}/head`]);
    if (fetched.status !== 0) return { number: pr.number, author: pr.author?.login, diff: '' };
    const sources: { path: string; content: string }[] = [];
    for (const symbol of symbols) {
      const hits = git(['grep', '-l', '-w', '-e', symbol, 'FETCH_HEAD', '--', '*.ts', '*.tsx']);
      if (hits.status !== 0) continue;
      const files = hits.stdout.split(/\r?\n/).map((line) => line.replace(/^FETCH_HEAD:/, '')).filter((path) => /\.tsx?$/.test(path));
      for (const file of files) {
        const source = git(['show', `FETCH_HEAD:${file}`]);
        if (source.status === 0) sources.push({ path: file, content: source.stdout });
      }
    }
    return { number: pr.number, author: pr.author?.login, headSha: pr.headRefOid, diff: '', sources };
  });
  const result = runTypeDriftRadar({
    changedExports: () => [...symbols],
    changedExportPaths: () => changedPaths,
    changedModuleFiles: () => changedModuleFiles,
    preChangeFiles: () => preChangeFiles,
    repoRoot: input.cwd,
    openPullRequests: () => pullsWithImports,
    typecheckOnLatestMain: (pr) => {
      const worktree = mkdtempSync(join(tmpdir(), `eln-drift-radar-${pr}-`));
      try {
        const added = git(['worktree', 'add', '--detach', worktree, mainSha]);
        if (added.status !== 0) return { passed: false, measured: false, output: `worktree add failed: ${added.stderr}` };
        const headSha = pullsWithImports.find((candidate) => candidate.number === pr)?.headSha;
        const fetched = git(['fetch', 'origin', `pull/${pr}/head`], worktree);
        if (fetched.status !== 0) return { passed: false, measured: false, output: `PR fetch failed: ${fetched.stderr}` };
        const actualHead = git(['rev-parse', 'FETCH_HEAD'], worktree).stdout.trim();
        if (headSha && actualHead.toLowerCase() !== headSha.toLowerCase()) return { passed: false, measured: false, output: 'PR head changed during radar scan; result is unmeasured.' };
        // The remote typecheck runner pins and pushes a commit. A worktree left in an uncommitted
        // merge state is rejected as dirty, so give this throwaway virtual merge a local identity.
        const merged = git(['-c', 'user.name=Elanous Drift Radar', '-c', 'user.email=drift-radar@localhost',
          'merge', '--no-ff', '--no-edit', 'FETCH_HEAD'], worktree);
        if (merged.status !== 0) return { passed: false, measured: false, output: `virtual merge failed: ${merged.stdout}\n${merged.stderr}` };
        const checked = run('bun', ['run', 'scripts/ci-typecheck-changed.ts', '--remote', 'node-c'], worktree, 3 * 60_000);
        return classifyDriftTypecheckResult({ status: checked.status, stdout: checked.stdout ?? '', stderr: checked.stderr ?? '', error: checked.error });
      } finally {
        git(['worktree', 'remove', '--force', worktree]);
        rmSync(worktree, { recursive: true, force: true });
      }
    },
    notifyOwner: (pr, author, body) => {
      const map: unknown = JSON.parse(process.env.ELANOUS_PR_CONFLICT_OWNER_MAP ?? '{}');
      const recipient = map && typeof map === 'object' && author && typeof (map as Record<string, unknown>)[author] === 'string'
        ? (map as Record<string, string>)[author]! : undefined;
      if (!recipient) return false;
      return run('eln', ['msg', 'post', '--from', 'OPC', '--to', recipient, '--kind', 'report', '--body', body]).status === 0;
    },
  });
  if (open.length >= 100) debug.log('pr.land', 'drift-radar-skipped', { reason: 'open-pr-list-truncated', listed: open.length });
  return result;
}
