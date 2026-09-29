#!/usr/bin/env bun
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { effectiveInstanceRoot } from '../../src/instance/resolve.js';
import { errorResult, finishNode, lastResult, nodeOutput, readGraphContext, runCommand, type CommandRunner } from './node-verdict.js';

export function runPrepare(run: CommandRunner = runCommand) {
  const context = readGraphContext();
  const { version, previousVersion } = context.input;
  const commit = nodeOutput(context, 'version-release', 'commit');
  for (const node of ['gate', 'pwa']) if (context.outputs[node]?.outcome !== 'ok') throw new Error(`${node} did not pass`);
  const out = join(effectiveInstanceRoot(), 'release', version, 'prepared');
  if (existsSync(out)) throw new Error(`prepare output already exists: ${out}`);
  const ref = `v${previousVersion}^{commit}`;
  const prev = run('git', ['rev-parse', '--verify', ref]);
  if (prev.status !== 0 || !/^[0-9a-f]{40}\s*$/i.test(prev.stdout)) throw new Error(`previous release ref unavailable: ${ref}`);
  const command = run('bun', ['bin/elanous.mjs', 'release', 'prepare', '--version', version, '--source', commit, '--notes-from', prev.stdout.trim(), '--out', out, '--json']);
  if (command.stderr) process.stderr.write(command.stderr);
  const manifest = lastResult(command)?.manifest as { version?: string; sourceCommit?: string; distDir?: string } | undefined;
  if (command.status === 1) return { outcome: 'fail' as const, verdict: 'fail' as const, summary: `prepare failed: ${lastResult(command)?.error ?? command.stderr.trim()}` };
  if (command.status !== 0 || manifest?.version !== version || manifest.sourceCommit !== commit || manifest.distDir !== join(out, 'dist')) {
    throw new Error(`prepare incomplete (rc=${command.status}): ${lastResult(command)?.error ?? command.stderr.trim()}`);
  }
  return { outcome: 'ok' as const, verdict: 'pass' as const, summary: `prepare ${version} · ${commit.slice(0, 12)}`, out, candidate: join(out, 'dist', 'elanous.tgz'), commit };
}

if (import.meta.main) {
  let version = '';
  try { version = readGraphContext().input.version; process.exitCode = finishNode('prepare', version, runPrepare()); }
  catch (error) { process.exitCode = finishNode('prepare', version, errorResult(error)); }
}
