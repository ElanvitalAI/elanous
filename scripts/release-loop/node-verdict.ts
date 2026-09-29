#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { debug } from '../../src/debug/log.js';

export type NodeOutcome = 'ok' | 'fail' | 'error';
export type NodeVerdict = 'pass' | 'flaky' | 'fail';
export interface GraphContext {
  input: { version: string; previousVersion: string; [key: string]: unknown };
  outputs: Record<string, Record<string, unknown>>;
}

export function readGraphContext(env: NodeJS.ProcessEnv = process.env): GraphContext {
  const location = env.ELANOUS_GRAPH_CONTEXT;
  if (!location) throw new Error('ELANOUS_GRAPH_CONTEXT required');
  const value: unknown = JSON.parse(location.trimStart().startsWith('{') ? location : readFileSync(location, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid graph context');
  const context = value as Record<string, unknown>;
  const input = context.input as Record<string, unknown> | undefined;
  if (!input || typeof input.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(input.version)
    || typeof input.previousVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(input.previousVersion)) throw new Error('version and previousVersion required');
  return { input: input as GraphContext['input'], outputs: context.outputs && typeof context.outputs === 'object' ? context.outputs as GraphContext['outputs'] : {} };
}

export function nodeOutput(context: GraphContext, node: string, key: string): string {
  const value = context.outputs[node]?.[key];
  if (typeof value !== 'string' || !value) throw new Error(`${node}.${key} required`);
  return value;
}

export function emitNodeResult<T extends Record<string, unknown>>(result: T & { outcome: NodeOutcome | 'regression'; verdict: NodeVerdict; summary: string }): void {
  console.log(JSON.stringify({ ...result, summary: result.summary.replace(/[\r\n]+/g, ' ').trim() }));
}

export interface CommandResult { status: number | null; stdout: string; stderr: string }
export type CommandRunner = (command: string, args: string[], cwd?: string) => CommandResult;
export const runCommand: CommandRunner = (command, args, cwd) => {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr || (result.error ? String(result.error) : '') };
};

export function lastResult(run: CommandResult): Record<string, unknown> | undefined {
  const line = run.stdout.trim().split('\n').at(-1);
  try {
    const value: unknown = JSON.parse(line ?? '');
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

export function finishNode(node: string, version: string, result: Record<string, unknown> & { outcome: NodeOutcome; verdict: NodeVerdict; summary: string }): number {
  debug.log(`release-loop.${node}`, 'result', { version, outcome: result.outcome });
  emitNodeResult(result);
  return result.outcome === 'ok' ? 0 : result.outcome === 'fail' ? 1 : 2;
}

export function errorResult(error: unknown): { outcome: 'error'; verdict: 'fail'; summary: string } {
  return { outcome: 'error', verdict: 'fail', summary: error instanceof Error ? error.message : String(error) };
}

// Existing cutoff/PWA/TUI programs have different output conventions; normalize them at the graph boundary.
if (import.meta.main) {
  const node = process.argv[2];
  let version = '';
  let result: Record<string, unknown> & { outcome: NodeOutcome; verdict: NodeVerdict; summary: string };
  try {
    const context = readGraphContext();
    version = context.input.version;
    const commit = nodeOutput(context, 'version-release', 'commit');
    const predecessor = node === 'pwa' ? 'gate' : node === 'tui' ? 'upgrade' : 'version-release';
    if (context.outputs[predecessor]?.outcome !== 'ok') throw new Error(`${predecessor} did not pass`);
    const args = node === 'cutoff' ? ['scripts/release-loop/cutoff.ts', '--version', version, '--cutoff', commit, '--baseline', `v${context.input.previousVersion}`, '--json']
      : node === 'pwa' ? ['scripts/release-loop/pwa-scenarios-node.ts', '--commit', commit, '--with-costly', '--json']
      : node === 'tui' ? ['scripts/release-loop/tui-sim-node.ts', '--commit', commit, '--json'] : (() => { throw new Error(`unknown node: ${node}`); })();
    const run = runCommand('bun', args);
    if (run.stderr) process.stderr.write(run.stderr);
    const data = lastResult(run);
    const verdict = data?.verdict;
    const baseline = data?.baseline as { sha?: string } | undefined;
    const outcome: NodeOutcome = node === 'cutoff' ? run.status === 0 && data?.version === version && (data?.cutoff as { sha?: string } | undefined)?.sha === commit && typeof baseline?.sha === 'string' ? 'ok' : 'error'
      : run.status === 0 && (verdict === 'pass' || verdict === 'flaky') ? 'ok' : run.status === 1 ? 'fail' : 'error';
    result = { ...data, outcome, verdict: outcome === 'ok' ? verdict === 'flaky' ? 'flaky' : 'pass' : 'fail',
      summary: outcome === 'ok' ? `${node} ${verdict === 'flaky' ? 'flaky' : 'pass'}` : `${node} ${data?.error || run.stderr.trim() || data?.verdict || 'failed'} (rc=${run.status})` };
  } catch (error) { result = errorResult(error); }
  process.exitCode = finishNode(node ?? 'unknown', version, result);
}
