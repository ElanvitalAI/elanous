#!/usr/bin/env bun
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { finishNode, nodeOutput, readGraphContext, runCommand, type CommandResult, type CommandRunner } from './node-verdict.js';
import { runExportCheckRemote, type ExportCheckRemoteOptions } from './export-check-remote.js';
import { runPwaBuildTypecheck, type PwaBuildTypecheckResult } from './pwa-build-typecheck.js';
import { resolveGateRemoteSettings } from '../../src/self-implement/gate-remote.js';
import { getUserConfig } from '../../src/user-config.js';

export interface ExportCheckResult extends Record<string, unknown> {
  outcome: 'ok' | 'fail' | 'error';
  verdict: 'pass' | 'fail';
  summary: string;
  step: 'export' | 'build';
  tail: string;
  diagnostics?: string[];
}

function exportTypeScriptDiagnostics(output: string): string[] {
  const plain = output.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '');
  const diagnostics: string[] = [];
  for (const line of plain.split(/\r?\n/u)) {
    const match = line.match(/^\s*(.+?\.(?:tsx?|jsx?))(?:\((\d+)(?:,\d+)?\)|:(\d+)(?::\d+)?)(?:\s*[-:]\s*|\s+)(?:error\s+)?(TS\d{4,5}):\s*(.*?)\s*$/u);
    if (!match) continue;
    const [, file, parenLine, colonLine, code, message] = match;
    diagnostics.push(`${file}:${parenLine ?? colonLine} ${code}: ${message}`);
  }
  return [...new Set(diagnostics)];
}

export function resolveExportCheckIdentity(
  argv: string[],
  readContext: typeof readGraphContext = readGraphContext,
): { commit: string; version: string } {
  const commitIndex = argv.indexOf('--commit');
  const versionIndex = argv.indexOf('--version');
  if ((commitIndex >= 0) !== (versionIndex >= 0)) {
    throw new Error('--commit and --version must be provided together');
  }
  if (commitIndex >= 0 && versionIndex >= 0) {
    const commit = argv[commitIndex + 1];
    const version = argv[versionIndex + 1];
    if (!commit || commit.startsWith('--') || !version || version.startsWith('--')) throw new Error('--commit and --version require values');
    return { commit, version };
  }
  const context = readContext();
  return { commit: nodeOutput(context, 'version-release', 'commit'), version: context.input.version };
}

export function resolveRemoteExportCheckInvocation(
  argv: string[],
  readContext: typeof readGraphContext = readGraphContext,
): { host: string; commit: string; version: string; graphContext?: string } {
  const remoteIndex = argv.indexOf('--remote');
  const remote = remoteIndex >= 0 ? argv[remoteIndex + 1] : undefined;
  if (remoteIndex >= 0 && (!remote || remote.startsWith('--'))) throw new Error('--remote requires aws1 or gcp2');
  const context = argv.includes('--commit') ? undefined : readContext();
  const identity = resolveExportCheckIdentity(argv, context ? () => context : readContext);
  const configuredHost = context?.input.exportCheckRemote;
  return {
    host: remote ?? (typeof configuredHost === 'string' ? configuredHost : 'aws1'),
    ...identity,
    ...(context ? { graphContext: JSON.stringify(context) } : {}),
  };
}

export function runRemoteExportCheckFromCli(
  argv: string[],
  dependencies: {
    readContext?: typeof readGraphContext;
    runRemote?: (input: ExportCheckRemoteOptions) => ExportCheckResult;
    repo?: string;
    mirror?: string;
  } = {},
): { version: string; result: ExportCheckResult } {
  const { host, commit, version, graphContext } = resolveRemoteExportCheckInvocation(argv, dependencies.readContext);
  const mirror = dependencies.mirror ?? resolveGateRemoteSettings(getUserConfig().gateRemote).mirror;
  const result = (dependencies.runRemote ?? runExportCheckRemote)({
    repo: dependencies.repo ?? process.cwd(), host, mirror, commit, version, ...(graphContext ? { graphContext } : {}),
  });
  return { version, result };
}

function failed(step: ExportCheckResult['step'], message: string, result?: CommandResult): ExportCheckResult {
  const tail = (result ? result.stderr || result.stdout : message).trim().slice(-300);
  return { outcome: 'fail', verdict: 'fail', summary: `${step} failed: ${message}${result ? ` (rc=${result.status})` : ''}`, step, tail };
}

/** Check the same public export and PWA build as release prepare, without cloning or writing to a public remote. */
export function runExportCheck(run: CommandRunner = runCommand, repoRoot = process.cwd(), identity?: { commit: string; version: string }): ExportCheckResult {
  const context = identity ? undefined : readGraphContext();
  const commit = identity?.commit ?? nodeOutput(context!, 'version-release', 'commit');
  const expectedVersion = identity?.version ?? context!.input.version;
  const root = resolve(repoRoot);
  const out = mkdtempSync(join(tmpdir(), 'elanous-export-check-'));
  const sourceDir = join(out, 'source');
  let added = false;
  let step: ExportCheckResult['step'] = 'export';
  let result: ExportCheckResult = failed(step, 'check incomplete');
  try {
    const modulesRoot = dirname(realpathSync(join(root, 'node_modules')));
    const add = run('git', ['worktree', 'add', '-q', '--detach', sourceDir, commit], root);
    if (add.status !== 0) result = failed('export', 'git worktree add', add);
    else {
      added = true;
      const head = run('git', ['rev-parse', 'HEAD'], sourceDir);
      if (head.status !== 0 || head.stdout.trim() !== commit) result = failed('export', 'cut commit mismatch', head);
      else {
        const version = (JSON.parse(readFileSync(join(sourceDir, 'package.json'), 'utf8')) as { version?: string }).version;
        if (version !== expectedVersion) result = failed('export', `package.json version ${version} != ${expectedVersion}`);
        else {
          symlinkSync(join(modulesRoot, 'node_modules'), join(sourceDir, 'node_modules'), 'dir');
          const exported = run('bun', ['scripts/public-export.ts', '--out', join(out, 'export')], sourceDir);
          if (exported.status !== 0) {
            result = failed('export', 'public export', exported);
            const leakEvidence = `${exported.stdout}\n${exported.stderr}`.split(/\r?\n/u)
              .filter((line) => /(?:absolute-home-path|kr-mobile-phone|pilot-tree|handoff-doc-link|plan-doc-link|xcode-author-header)\s/u.test(line))
              .slice(0, 8).join('\n');
            if (leakEvidence) result = { ...result, tail: leakEvidence.slice(-1_000) };
          }
          else {
            step = 'build';
            const publicDir = join(out, 'export');
            symlinkSync(join(modulesRoot, 'node_modules'), join(publicDir, 'node_modules'), 'dir');
            let pwaModules = join(root, 'apps', 'pwa', 'node_modules');
            let pwaReady = existsSync(pwaModules);
            if (!pwaReady) {
              const installed = run('bun', ['install', '--cwd', join(root, 'apps', 'pwa'), '--frozen-lockfile'], root);
              if (installed.status !== 0) {
                // This path was absent before install. Remove partial output so a later retry cannot mistake it for a complete install.
                let cleanupFailed = false;
                try { rmSync(pwaModules, { recursive: true, force: true }); }
                catch (error) {
                  cleanupFailed = true;
                  result = failed('build', `PWA dependency install partial-output cleanup: ${error instanceof Error ? error.message : String(error)}`, installed);
                }
                if (!cleanupFailed) result = failed('build', 'PWA dependency install', installed);
              }
              else {
                pwaReady = existsSync(pwaModules);
                if (!pwaReady) result = failed('build', 'PWA dependency install did not create apps/pwa/node_modules', installed);
              }
            }
            if (pwaReady) {
              pwaModules = realpathSync(pwaModules);
              if (existsSync(join(publicDir, 'apps', 'pwa'))) symlinkSync(pwaModules, join(publicDir, 'apps', 'pwa', 'node_modules'), 'dir');
              const built = run('bun', ['bin/elanous.mjs', 'nexus', 'build'], publicDir);
              if (built.status === 0 && existsSync(join(publicDir, 'apps', 'pwa', 'out', 'index.html'))) {
                result = { outcome: 'ok', verdict: 'pass', summary: `public export and PWA build ${commit.slice(0, 12)}`, step: 'build', tail: '' };
              } else {
                const failure = failed('build', 'PWA build or out/index.html missing', built);
                const diagnostics = exportTypeScriptDiagnostics(`${built.stdout}\n${built.stderr}`);
                result = diagnostics.length > 0 ? { ...failure, diagnostics } : failure;
              }
            }
          }
        }
      }
    }
  } catch (error) {
    result = failed(step, error instanceof Error ? error.message : String(error));
  } finally {
    try {
      if (added) {
        const removed = run('git', ['worktree', 'remove', '--force', sourceDir], root);
        if (removed.status !== 0) result = failed(step, 'git worktree remove', removed);
      }
    } catch (error) {
      result = failed(step, `git worktree remove: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }
  return result;
}

if (import.meta.main) {
  let version = '';
  try {
    const argv = process.argv.slice(2);
    if (argv.includes('--pwa-typecheck')) {
      const take = (name: string): string | undefined => {
        const index = argv.indexOf(name);
        return index < 0 ? undefined : argv[index + 1];
      };
      const remoteHost = take('--remote');
      const repo = take('--repo') ?? process.cwd();
      if (!remoteHost || remoteHost.startsWith('-') || argv.some((arg) => !['--pwa-typecheck', '--remote', remoteHost, '--repo', repo].includes(arg))) {
        const result: PwaBuildTypecheckResult = { status: 'unmeasured', summary: 'usage: export-check-node.ts --pwa-typecheck --remote aws1|aws2|gcp2 [--repo <clean PR tree>]' };
        process.stdout.write(`${JSON.stringify(result)}\n`);
        process.exitCode = 2;
      } else {
        const result = runPwaBuildTypecheck({ repo, host: remoteHost, mirror: resolveGateRemoteSettings(getUserConfig().gateRemote).mirror });
        process.stdout.write(`${JSON.stringify(result)}\n`);
        process.exitCode = result.status === 'passed' || result.status === 'skipped' ? 0 : result.status === 'failed' ? 1 : 2;
      }
    } else {
      const local = argv.includes('--local');
      const remoteIndex = argv.indexOf('--remote');
      const remote = remoteIndex >= 0 ? argv[remoteIndex + 1] : undefined;
      const commitIndex = argv.indexOf('--commit');
      const versionIndex = argv.indexOf('--version');
      if (remoteIndex >= 0 && local) throw new Error('--remote and --local cannot be combined');
      if (remoteIndex >= 0 && !remote) throw new Error('--remote requires aws1 or gcp2');
      if (local) {
        const commit = argv[commitIndex + 1];
        version = argv[versionIndex + 1] ?? '';
        if (!commit || !version) throw new Error('--local requires --commit <sha> and --version <version>');
        process.exitCode = finishNode('export-check', version, runExportCheck(runCommand, process.cwd(), { commit, version }));
      } else {
        const remote = runRemoteExportCheckFromCli(argv);
        version = remote.version;
        const result = remote.result;
        process.exitCode = finishNode('export-check', version, result);
      }
    }
  } catch (error) {
    process.exitCode = finishNode('export-check', version, { ...failed('export', error instanceof Error ? error.message : String(error)), outcome: 'error' });
  }
}
