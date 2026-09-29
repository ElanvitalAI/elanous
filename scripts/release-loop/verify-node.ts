#!/usr/bin/env bun
import { errorResult, finishNode, lastResult, nodeOutput, readGraphContext, runCommand, type CommandRunner } from './node-verdict.js';

export function runVerify(run: CommandRunner = runCommand) {
  const context = readGraphContext();
  if (context.outputs['docs-land']?.outcome !== 'ok') throw new Error('docs must land and deploy before verify');
  if (nodeOutput(context, 'publish', 'tag') !== `v${context.input.version}`) throw new Error('published tag/version mismatch');
  const output = run('bun', ['bin/elanous.mjs', 'release', 'verify', '--version', context.input.version, '--json']);
  if (output.stderr) process.stderr.write(output.stderr);
  const result = lastResult(output);
  const passed = output.status === 0 && result?.ok === true && result.notesPage === 'ok';
  if (output.status === null || output.status === 2 || !result) throw new Error(`release verify incomplete: ${output.stderr.trim()}`);
  return { outcome: passed ? 'ok' as const : 'fail' as const, verdict: passed ? 'pass' as const : 'fail' as const,
    summary: passed ? `verify v${context.input.version} · notes page ok` : `verify failed: ${result?.error ?? result?.notesPage ?? output.stderr.trim()}` };
}

if (import.meta.main) {
  let version = '';
  try { version = readGraphContext().input.version; process.exitCode = finishNode('verify', version, runVerify()); }
  catch (error) { process.exitCode = finishNode('verify', version, errorResult(error)); }
}
