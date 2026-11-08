import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import * as ts from 'typescript';
import { runCommand, type CommandRunner } from './node-verdict.js';
import { runOnRemote, resolveGateRemoteSettings, type RemoteRunOptions, type RemoteRunOutcome } from '../../src/self-implement/gate-remote.js';
import { getUserConfig } from '../../src/user-config.js';

export const PWA_BUILD_TYPECHECK_HOSTS = ['aws1', 'aws2', 'gcp2'] as const;
export const PWA_BUILD_TYPECHECK_TIMEOUT_MS = 15 * 60_000;

export interface PwaBuildTypecheckResult {
  status: 'skipped' | 'passed' | 'failed' | 'unmeasured';
  summary: string;
  host?: string;
  tail?: string;
}

export function pwaBuildTypecheckAffected(changedFiles: readonly string[], pwaProgramFiles: ReadonlySet<string>): boolean {
  const normalizedChanged = changedFiles.map((file) => file.replaceAll('\\', '/').replace(/^\.\//u, ''));
  if (normalizedChanged.some((file) => file === 'apps/pwa' || file.startsWith('apps/pwa/'))) return true;
  return normalizedChanged.some((file) => pwaProgramFiles.has(file));
}

/** Files in the PWA TypeScript program include its transitive imports from the repository's src/ and scripts/. */
export function pwaBuildTypecheckProgramFiles(repoRoot = process.cwd()): Set<string> {
  const root = resolve(repoRoot);
  const configPath = join(root, 'apps', 'pwa', 'tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath), {}, configPath);
  if (parsed.errors.length) throw new Error(ts.formatDiagnostics(parsed.errors, {
    getCanonicalFileName: (file) => file,
    getCurrentDirectory: () => root,
    getNewLine: () => '\n',
  }));
  const cache = ts.createModuleResolutionCache(root, (file) => file, parsed.options);
  const pending = [...parsed.fileNames];
  const visited = new Set<string>();
  const result = new Set<string>();
  while (pending.length) {
    const file = resolve(pending.pop()!);
    if (visited.has(file)) continue;
    visited.add(file);
    const path = relative(root, file).replaceAll('\\', '/');
    if (path === '..' || path.startsWith('../')) continue;
    result.add(path);
    const source = ts.createSourceFile(file, ts.sys.readFile(file) ?? '', ts.ScriptTarget.Latest, true);
    const specifiers: string[] = [];
    const visit = (node: ts.Node): void => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        specifiers.push(node.moduleSpecifier.text);
      } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
        specifiers.push(node.argument.literal.text);
      } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require')) && ts.isStringLiteral(node.arguments[0])) {
        specifiers.push(node.arguments[0].text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    for (const specifier of specifiers) {
      const resolved = ts.resolveModuleName(specifier, file, parsed.options, ts.sys, cache).resolvedModule?.resolvedFileName;
      if (!resolved) continue;
      const resolvedPath = relative(root, resolve(resolved)).replaceAll('\\', '/');
      if (resolvedPath !== '..' && !resolvedPath.startsWith('../') && !visited.has(resolve(resolved))) pending.push(resolved);
    }
  }
  return result;
}

export function pwaBuildTypecheckRemoteArgv(): string[] {
  return ['bash', '-lc', [
    'set -u',
    'PWA_TMP=$(mktemp -d "${TMPDIR:-/tmp}/pwa-typecheck.XXXXXX") || exit 19',
    'trap \'rm -rf "$PWA_TMP"\' EXIT',
    'pwa_install() { bun install --frozen-lockfile >/dev/null && (cd apps/pwa && bun install --frozen-lockfile >/dev/null); }',
    'pwa_check() { bun run --cwd apps/pwa typecheck --pretty false; }',
    'git -c user.name="PWA typecheck" -c user.email="pwa-typecheck@example.invalid" merge --no-commit --no-ff origin/main || exit 20',
    'pwa_install || exit 21',
    'pwa_check > "$PWA_TMP/merged.log" 2>&1; merged_rc=$?',
    'git merge --abort >/dev/null 2>&1 || git reset --hard HEAD >/dev/null || exit 22',
    'git checkout --detach origin/main || exit 23',
    'pwa_install || exit 24',
    'pwa_check > "$PWA_TMP/main.log" 2>&1; main_rc=$?',
    "grep -E 'error TS[0-9]+:' \"$PWA_TMP/merged.log\" | sort > \"$PWA_TMP/merged.errors\" || true",
    "grep -E 'error TS[0-9]+:' \"$PWA_TMP/main.log\" | sort > \"$PWA_TMP/main.errors\" || true",
    'comm -23 "$PWA_TMP/merged.errors" "$PWA_TMP/main.errors" > "$PWA_TMP/introduced.errors"',
    'merged_count=$(wc -l < "$PWA_TMP/merged.errors" | tr -d " "); main_count=$(wc -l < "$PWA_TMP/main.errors" | tr -d " "); introduced_count=$(wc -l < "$PWA_TMP/introduced.errors" | tr -d " ")',
    'printf "PWA_TYPECHECK_MAIN rc=%s diagnostics=%s\\nPWA_TYPECHECK_MERGED rc=%s diagnostics=%s introduced=%s\\n" "$main_rc" "$main_count" "$merged_rc" "$merged_count" "$introduced_count"',
    '[ "$main_rc" -eq 0 ] || [ "$main_count" -gt 0 ] || exit 25',
    '[ "$merged_rc" -eq 0 ] || [ "$merged_count" -gt 0 ] || exit 26',
    '[ "$introduced_count" -eq 0 ] || { cat "$PWA_TMP/introduced.errors"; exit 1; }',
    'exit 0',
  ].join('\n')];
}

export function runPwaBuildTypecheck(input: { repo: string; host: string; mirror: string }, dependencies: {
  run?: CommandRunner;
  runRemote?: (options: RemoteRunOptions) => RemoteRunOutcome;
  pwaProgramFiles?: ReadonlySet<string>;
  baselinePwaProgramFiles?: ReadonlySet<string>;
  targetPwaProgramFiles?: ReadonlySet<string>;
  integratedPwaProgramFiles?: ReadonlySet<string>;
} = {}): PwaBuildTypecheckResult {
  const root = resolve(input.repo);
  if (!(PWA_BUILD_TYPECHECK_HOSTS as readonly string[]).includes(input.host)) {
    return { status: 'unmeasured', summary: `PWA typecheck host must be aws1, aws2, or gcp2 (got ${input.host})` };
  }
  const run = dependencies.run ?? runCommand;
  const clean = run('git', ['status', '--porcelain'], root);
  if (clean.status !== 0 || clean.stdout.trim()) return { status: 'unmeasured', summary: 'PWA typecheck requires a clean PR tree' };
  const fetched = run('git', ['fetch', '-q', 'origin', 'main'], root);
  if (fetched.status !== 0) return { status: 'unmeasured', summary: 'cannot fetch origin/main for PWA typecheck' };
  const head = run('git', ['rev-parse', 'HEAD'], root);
  const base = run('git', ['rev-parse', 'origin/main'], root);
  if (head.status !== 0 || !/^[0-9a-f]{40}$/iu.test(head.stdout.trim()) || base.status !== 0 || !/^[0-9a-f]{40}$/iu.test(base.stdout.trim())) {
    return { status: 'unmeasured', summary: 'cannot resolve full PR head and origin/main for PWA typecheck' };
  }
  const mergeBase = run('git', ['merge-base', base.stdout.trim(), head.stdout.trim()], root);
  if (mergeBase.status !== 0 || !/^[0-9a-f]{40}$/iu.test(mergeBase.stdout.trim())) {
    return { status: 'unmeasured', summary: 'cannot resolve PR diff base for PWA typecheck' };
  }
  const changed = run('git', ['diff', '--name-only', '--no-renames', mergeBase.stdout.trim(), head.stdout.trim()], root);
  if (changed.status !== 0) return { status: 'unmeasured', summary: 'cannot read changed files for PWA typecheck' };
  let programFiles: ReadonlySet<string>;
  let baselineProgramFiles: ReadonlySet<string>;
  let targetProgramFiles: ReadonlySet<string>;
  let integratedProgramFiles: ReadonlySet<string>;
  try {
    programFiles = dependencies.pwaProgramFiles ?? pwaBuildTypecheckProgramFiles(root);
    baselineProgramFiles = dependencies.baselinePwaProgramFiles ?? pwaBuildTypecheckProgramFilesAtRef(root, mergeBase.stdout.trim(), run);
    targetProgramFiles = dependencies.targetPwaProgramFiles ?? pwaBuildTypecheckProgramFilesAtRef(root, base.stdout.trim(), run);
    integratedProgramFiles = dependencies.integratedPwaProgramFiles ?? pwaBuildTypecheckProgramFilesForIntegration(root, base.stdout.trim(), head.stdout.trim(), run);
  }
  catch (error) { return { status: 'unmeasured', summary: `cannot resolve PWA imports: ${error instanceof Error ? error.message : String(error)}` }; }
  const affectedProgramFiles = new Set([...programFiles, ...baselineProgramFiles, ...targetProgramFiles, ...integratedProgramFiles]);
  if (!pwaBuildTypecheckAffected(changed.stdout.split(/\r?\n/u).filter(Boolean), affectedProgramFiles)) {
    return { status: 'skipped', summary: 'PR does not change apps/pwa or files in the PWA TypeScript import graph' };
  }
  const outcome = (dependencies.runRemote ?? runOnRemote)({
    repo: root, host: input.host, mirror: input.mirror, commit: head.stdout.trim(),
    argv: pwaBuildTypecheckRemoteArgv(), installPwa: false, timeoutMs: PWA_BUILD_TYPECHECK_TIMEOUT_MS,
  });
  if (outcome.kind !== 'ran') {
    return { status: 'unmeasured', summary: `remote PWA typecheck ${outcome.kind === 'busy' ? 'host busy' : outcome.reason}`, host: input.host,
      tail: outcome.kind === 'infra' ? outcome.stderr?.trim().slice(-1000) ?? '' : '' };
  }
  const tail = [outcome.stdout.toString('utf8').trim(), outcome.stderr.toString('utf8').trim()].filter(Boolean).join('\n').slice(-1000);
  return outcome.rc === 0
    ? { status: 'passed', summary: `PWA typecheck introduced no errors versus origin/main after merge at ${head.stdout.trim().slice(0, 12)}`, host: outcome.host, tail }
    : { status: 'failed', summary: `PWA typecheck introduced errors versus origin/main (rc=${outcome.rc})`, host: outcome.host, tail };
}

function pwaBuildTypecheckProgramFilesAtRef(repo: string, ref: string, run: CommandRunner): Set<string> {
  const root = resolve(repo);
  const worktree = mkdtempSync(join(tmpdir(), 'pwa-typecheck-base-'));
  try {
    const added = run('git', ['worktree', 'add', '--detach', worktree, ref], root);
    if (added.status !== 0) throw new Error(`cannot prepare PWA baseline worktree: ${added.stderr.trim()}`);
    symlinkSync(join(root, 'node_modules'), join(worktree, 'node_modules'), 'dir');
    symlinkSync(join(root, 'apps', 'pwa', 'node_modules'), join(worktree, 'apps', 'pwa', 'node_modules'), 'dir');
    return pwaBuildTypecheckProgramFiles(worktree);
  } finally {
    run('git', ['worktree', 'remove', '--force', worktree], root);
    rmSync(worktree, { recursive: true, force: true });
  }
}

export function pwaBuildTypecheckProgramFilesForIntegration(repo: string, targetRef: string, headRef: string, run: CommandRunner = runCommand): Set<string> {
  const root = resolve(repo);
  const tree = run('git', ['merge-tree', '--write-tree', targetRef, headRef], root);
  const treeSha = tree.stdout.trim().split(/\s+/u)[0] ?? '';
  if (tree.status !== 0 || !/^[0-9a-f]{40}$/iu.test(treeSha)) {
    throw new Error(`cannot resolve PWA integration tree: ${tree.stderr.trim() || tree.stdout.trim()}`);
  }
  const commit = run('git', ['-c', 'user.name=PWA typecheck', '-c', 'user.email=pwa-typecheck@example.invalid', 'commit-tree', treeSha, '-p', targetRef, '-p', headRef], root);
  const commitSha = commit.stdout.trim();
  if (commit.status !== 0 || !/^[0-9a-f]{40}$/iu.test(commitSha)) {
    throw new Error(`cannot prepare PWA integration snapshot: ${commit.stderr.trim()}`);
  }
  return pwaBuildTypecheckProgramFilesAtRef(root, commitSha, run);
}

