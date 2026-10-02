#!/usr/bin/env bun
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { finishNode, nodeOutput, readGraphContext, runCommand, type CommandResult, type CommandRunner } from './node-verdict.js';

export interface ExportCheckResult extends Record<string, unknown> {
  outcome: 'ok' | 'fail';
  verdict: 'pass' | 'fail';
  summary: string;
  step: 'export' | 'build';
  tail: string;
}

function failed(step: ExportCheckResult['step'], message: string, result?: CommandResult): ExportCheckResult {
  const tail = (result ? result.stderr || result.stdout : message).trim().slice(-300);
  return { outcome: 'fail', verdict: 'fail', summary: `${step} failed: ${message}${result ? ` (rc=${result.status})` : ''}`, step, tail };
}

/** Check the same public export and PWA build as release prepare, without cloning or writing to a public remote. */
export function runExportCheck(run: CommandRunner = runCommand, repoRoot = process.cwd()): ExportCheckResult {
  const context = readGraphContext();
  const commit = nodeOutput(context, 'version-release', 'commit');
  if (context.outputs.gate?.outcome !== 'ok') return failed('export', 'gate did not pass');
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
        if (version !== context.input.version) result = failed('export', `package.json version ${version} != ${context.input.version}`);
        else {
          symlinkSync(join(modulesRoot, 'node_modules'), join(sourceDir, 'node_modules'), 'dir');
          const exported = run('bun', ['scripts/public-export.ts', '--out', join(out, 'export')], sourceDir);
          if (exported.status !== 0) result = failed('export', 'public export', exported);
          else {
            step = 'build';
            const publicDir = join(out, 'export');
            symlinkSync(join(modulesRoot, 'node_modules'), join(publicDir, 'node_modules'), 'dir');
            const pwaModules = join(modulesRoot, 'apps', 'pwa', 'node_modules');
            if (existsSync(pwaModules) && existsSync(join(publicDir, 'apps', 'pwa'))) symlinkSync(pwaModules, join(publicDir, 'apps', 'pwa', 'node_modules'), 'dir');
            const built = run('bun', ['bin/elanous.mjs', 'nexus', 'build'], publicDir);
            result = built.status === 0 && existsSync(join(publicDir, 'apps', 'pwa', 'out', 'index.html'))
              ? { outcome: 'ok', verdict: 'pass', summary: `public export and PWA build ${commit.slice(0, 12)}`, step: 'build', tail: '' }
              : failed('build', 'PWA build or out/index.html missing', built);
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
    version = readGraphContext().input.version;
    process.exitCode = finishNode('export-check', version, runExportCheck());
  } catch (error) {
    process.exitCode = finishNode('export-check', version, failed('export', error instanceof Error ? error.message : String(error)));
  }
}
