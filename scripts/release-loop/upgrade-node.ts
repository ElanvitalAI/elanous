#!/usr/bin/env bun
import { existsSync } from 'node:fs';
import { errorResult, finishNode, nodeOutput, readGraphContext, runCommand, type CommandRunner, type NodeOutcome } from './node-verdict.js';

export function runUpgrade(run: CommandRunner = runCommand) {
  const context = readGraphContext();
  if (context.outputs.prepare?.outcome !== 'ok') throw new Error('prepare did not pass');
  if (nodeOutput(context, 'prepare', 'commit') !== nodeOutput(context, 'version-release', 'commit')) throw new Error('prepare commit differs from release commit');
  const candidate = nodeOutput(context, 'prepare', 'candidate');
  if (!existsSync(candidate)) throw new Error(`candidate missing: ${candidate}`);
  const output = run('bash', ['scripts/release-upgrade-check.sh', '--from', context.input.previousVersion, '--candidate', candidate]);
  if (output.stderr) process.stderr.write(output.stderr);
  const verdicts = output.stdout.split('\n').filter((line) => /\[upgrade\] verdict\b/.test(line));
  const passed = verdicts.length === 2 && verdicts.some((line) => /^ubuntu:24\.04\s+\[upgrade\] verdict ok\s*$/.test(line))
    && verdicts.some((line) => /^debian:12\s+\[upgrade\] verdict ok\s*$/.test(line));
  const outcome: NodeOutcome = output.status === 0 && passed ? 'ok' : verdicts.length === 0 || output.status === null || output.status === 2 ? 'error' : 'fail';
  return { outcome, verdict: outcome === 'ok' ? 'pass' as const : 'fail' as const,
    summary: outcome === 'ok' ? `upgrade ${context.input.previousVersion} → ${context.input.version} · ${verdicts.length} images` : `upgrade failed (rc=${output.status}): ${output.stdout.trim().split('\n').at(-1) || output.stderr.trim() || 'no upgrade verdict'}` };
}

if (import.meta.main) {
  let version = '';
  try { version = readGraphContext().input.version; process.exitCode = finishNode('upgrade', version, runUpgrade()); }
  catch (error) { process.exitCode = finishNode('upgrade', version, errorResult(error)); }
}
