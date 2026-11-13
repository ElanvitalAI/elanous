#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { isReleaseVersion } from './release-version.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { effectiveInstanceRoot } from '../../src/instance/resolve.js';
import { assertSignedPwaBranchWaiver } from '../../src/graph-runner/release-pwa-waiver.js';
import type { GraphRunState } from '../../src/graph-runner/runner-types.js';
import { debug } from '../../src/debug/log.js';
import { runWithReleasePwaTraffic } from './gate-traffic-mode.js';

export type NodeOutcome = 'ok' | 'fail' | 'error' | 'partial' | 'unknown' | 'recovery-required' | 'switch' | 'stay-normal' | 'legacy' | 'audit';
export type NodeVerdict = 'pass' | 'flaky' | 'fail';
export interface GraphContext {
  graphId?: string;
  nodeId?: string;
  runId?: string;
  parentRunId?: string;
  executionId?: string;
  startedAt?: string;
  input: { version: string; previousVersion: string; [key: string]: unknown };
  nodeInput?: Record<string, unknown>;
  outputs: Record<string, Record<string, unknown>>;
  /** Ordered executions let re-entered nodes select the verdict from the latest gate visit. */
  nodeHistory?: Array<{ nodeId: string; executionId?: string; startedAt?: string; endedAt?: string; output?: unknown }>;
}

export function latestGateOutput(context: GraphContext): Record<string, unknown> | undefined {
  const latest = [...(context.nodeHistory ?? [])].reverse().find((node) =>
    (node.nodeId === 'gate' || node.nodeId === 'residual-run'));
  if (latest) {
    if (latest.output === undefined) return undefined;
    const output = latest.output;
    if (output && typeof output === 'object' && !Array.isArray(output)) return output as Record<string, unknown>;
    if (typeof output === 'string') {
      try { const parsed: unknown = JSON.parse(output);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
      } catch { /* malformed output remains unavailable */ }
    }
    return undefined;
  }
  return context.outputs.gate ?? context.outputs['residual-run'];
}

/** The only release run authorized to continue after a recorded failed gate.
 * graph approve validates the pinned JUD v2 document/table before recording
 * this OP decision and the adaptive traffic-gate-passed edge. */
export function signedT6KnownIssueGatePassed(context: GraphContext): boolean {
  const gate = context.outputs.gate;
  const approval = context.outputs['gate-heal-decision'];
  const traffic = context.outputs['traffic-gate-passed'];
  const cut = '7d951adb3163ba16a784d5b937d12732ef9be625';
  return context.graphId === 'release-loop'
    && (context.runId === '636f9e96-0aae-4cb0-babd-b509c44e2f34'
      || context.parentRunId === '636f9e96-0aae-4cb0-babd-b509c44e2f34')
    && context.input.version === '0.3.15'
    && context.outputs['version-release']?.commit === cut
    && gate?.outcome === 'error' && gate.commit === cut
    && Array.isArray(gate.introduced) && gate.introduced.length === 0
    && gate.error === 'Error: remote gate refused: HQ shard result batch is incomplete (pod-68)'
    && approval?.outcome === 'waived-known-issue'
    && approval.graphId === context.graphId && approval.runId === '636f9e96-0aae-4cb0-babd-b509c44e2f34'
    && approval.nodeId === 'gate-heal-decision' && approval.decidedBy === 'OP'
    && typeof approval.decidedAt === 'string' && !Number.isNaN(Date.parse(approval.decidedAt))
    && traffic?.outcome === 'ok';
}

export function gatePassedForRelease(context: GraphContext): boolean {
  return context.outputs.gate?.outcome === 'ok' || signedT6KnownIssueGatePassed(context);
}

/** Recheck the persisted fan-out waiver and its pinned OP/JUD receipts before publication. */
export function signedT6PwaKnownIssue(context: GraphContext, root = effectiveInstanceRoot()): boolean {
  const runId = context.runId;
  const cut = context.outputs['version-release']?.commit;
  if (context.graphId !== 'release-loop' || typeof runId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(runId)
    || context.input.version !== '0.3.15' || typeof cut !== 'string' || !/^[a-f0-9]{40}$/.test(cut)
    || context.outputs.pwa?.outcome !== 'fail' || context.outputs.pwa?.commit !== cut) return false;
  try {
    const state = JSON.parse(readFileSync(join(root, 'graph-runs/release-loop', `${runId}.json`), 'utf8')) as GraphRunState;
    if (state.runId !== runId || (state.input as { version?: string } | undefined)?.version !== context.input.version
      || JSON.parse(String(state.nodes.find(node => node.nodeId === 'version-release')?.output ?? '{}')).commit !== cut) return false;
    assertSignedPwaBranchWaiver(state, root, true);
    return state.fanOuts?.['traffic-gate-passed:ok']?.branches.pwa?.output === JSON.stringify(context.outputs.pwa);
  } catch { return false; }
}

export function readGraphContext(env: NodeJS.ProcessEnv = process.env): GraphContext {
  const location = env.ELANOUS_GRAPH_CONTEXT;
  if (!location) throw new Error('ELANOUS_GRAPH_CONTEXT required');
  const value: unknown = JSON.parse(location.trimStart().startsWith('{') ? location : readFileSync(location, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid graph context');
  const context = value as Record<string, unknown>;
  const input = context.input as Record<string, unknown> | undefined;
  if (!input || typeof input.version !== 'string' || !isReleaseVersion(input.version)
    || typeof input.previousVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(input.previousVersion)) throw new Error('version and previousVersion required');
  return { ...(typeof context.graphId === 'string' ? { graphId: context.graphId } : {}),
    ...(typeof context.parentRunId === 'string' ? { parentRunId: context.parentRunId } : {}),
    ...(typeof context.nodeId === 'string' ? { nodeId: context.nodeId } : {}),
    ...(typeof context.runId === 'string' ? { runId: context.runId } : {}),
    ...(typeof context.executionId === 'string' ? { executionId: context.executionId } : {}),
    ...(typeof context.startedAt === 'string' ? { startedAt: context.startedAt } : {}),
    input: input as GraphContext['input'],
    ...(context.nodeInput && typeof context.nodeInput === 'object' && !Array.isArray(context.nodeInput)
      ? { nodeInput: context.nodeInput as Record<string, unknown> } : {}),
    outputs: context.outputs && typeof context.outputs === 'object' ? context.outputs as GraphContext['outputs'] : {},
    ...(Array.isArray(context.nodeHistory) ? { nodeHistory: context.nodeHistory as GraphContext['nodeHistory'] } : {}) };
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
export type CommandRunner = (command: string, args: string[], cwd?: string, timeoutMs?: number) => CommandResult;
export const runCommand: CommandRunner = (command, args, cwd, timeoutMs) => {
  const result = spawnSync(command, args, { cwd, timeout: timeoutMs, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr || (result.error ? String(result.error) : '') };
};

export function lastResult(run: CommandResult): Record<string, unknown> | undefined {
  const line = run.stdout.trim().split('\n').at(-1);
  try {
    const value: unknown = JSON.parse(line ?? '');
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

export function finishNode(node: string, version: string, result: Record<string, unknown> & { outcome: NodeOutcome; verdict: NodeVerdict; summary: string; tail?: string }): number {
  debug.log(`release-loop.${node}`, 'result', { version, outcome: result.outcome });
  if (result.outcome === 'fail') {
    const summary = result.summary.replace(/[\r\n]+/g, ' ').trim();
    const tail = result.tail?.trim() ? result.tail : summary;
    debug.log('release.node', 'failed', { node, summary, tail });
    emitNodeResult({ ...result, summary, tail });
  } else emitNodeResult(result);
  return result.outcome === 'ok' || result.outcome === 'partial' || result.outcome === 'unknown' ? 0 : result.outcome === 'fail' ? 1 : 2;
}

export function errorResult(error: unknown): { outcome: 'error'; verdict: 'fail'; summary: string } {
  return { outcome: 'error', verdict: 'fail', summary: error instanceof Error ? error.message : String(error) };
}

/** A cut whose notes would show users nothing fails the cutoff instead of shipping a «Plus N internal changes.» page. */
export function cutoffNotesEmpty(data: Record<string, unknown> | undefined): boolean {
  return Array.isArray(data?.escalate) && (data.escalate as Array<{ kind?: string }>).some((item) => item?.kind === 'notes-empty');
}

/**
 * RELEASE-PWA-NODE-RESILIENCE ① — the pwa node's argv. `release.loop.pwaRemote` (copied into the run input) picks
 * the SSH host the suite runs on; absent = this machine (today's argv, byte-identical). One setting, like `gateRemote`.
 */
export function pwaNodeArgs(commit: string, input: Record<string, unknown>): string[] {
  const remote = input.pwaRemote;
  if (remote !== undefined && (typeof remote !== 'string' || !remote.trim())) throw new Error(`release.loop.pwaRemote must be an ssh host: ${String(remote)}`);
  // C1 (costly) needs a live model, but the node always builds a fresh isolated test universe with no LLM credentials,
  // so it can never pass there. Opt in with run input `pwaWithCostly: true` (until a mock-model device replaces it).
  return ['scripts/release-loop/pwa-scenarios-node.ts', '--commit', commit, ...(input.pwaWithCostly === true ? ['--with-costly'] : []), '--json',
    ...(typeof remote === 'string' ? ['--remote', remote.trim()] : [])];
}

// Existing cutoff/PWA/TUI programs have different output conventions; normalize them at the graph boundary.
export async function runNodeVerdict(argv: string[], env: NodeJS.ProcessEnv = process.env,
  runner: CommandRunner = runCommand): Promise<number> {
  const node = argv[0];
  let version = '';
  const execute = async (): Promise<number> => {
    let result: Record<string, unknown> & { outcome: NodeOutcome; verdict: NodeVerdict; summary: string };
    try {
      const context = readGraphContext(env);
      version = context.input.version;
      const commit = nodeOutput(context, 'version-release', 'commit');
      const predecessor = node === 'pwa' ? 'gate' : node === 'tui' ? 'upgrade' : 'version-release';
      if (predecessor === 'gate' ? !gatePassedForRelease(context) : context.outputs[predecessor]?.outcome !== 'ok')
        throw new Error(`${predecessor} did not pass`);
      const args = node === 'cutoff' ? ['scripts/release-loop/cutoff.ts', '--version', version, '--cutoff', commit, '--baseline', `v${context.input.previousVersion}`, '--json']
        : node === 'pwa' ? pwaNodeArgs(commit, context.input)
        : node === 'tui' ? ['scripts/release-loop/tui-sim-node.ts', '--commit', commit, '--json'] : (() => { throw new Error(`unknown node: ${node}`); })();
      const run = runner('bun', args);
      if (run.stderr) process.stderr.write(run.stderr);
      const data = lastResult(run);
      const verdict = data?.verdict;
      const baseline = data?.baseline as { sha?: string } | undefined;
      const outcome: NodeOutcome = node === 'cutoff' ? run.status === 0 && data?.version === version && (data?.cutoff as { sha?: string } | undefined)?.sha === commit && typeof baseline?.sha === 'string' ? 'ok' : 'error'
        : run.status === 0 && (verdict === 'pass' || verdict === 'flaky') ? 'ok' : run.status === 1 ? 'fail' : 'error';
      if (node === 'cutoff' && outcome === 'ok' && cutoffNotesEmpty(data)) {
        result = { ...data, outcome: 'fail', verdict: 'fail', summary: 'cutoff notes-empty — 사용자에게 보일 변경 줄이 0이다(release/next.md 와 PR 노트 조각을 확인하라)' };
      } else result = { ...data, outcome, verdict: outcome === 'ok' ? verdict === 'flaky' ? 'flaky' : 'pass' : 'fail',
        summary: outcome === 'ok' ? `${node} ${verdict === 'flaky' ? 'flaky' : 'pass'}` : `${node} ${data?.error || run.stderr.trim() || data?.verdict || 'failed'} (rc=${run.status})` };
    } catch (error) { result = errorResult(error); }
    return finishNode(node ?? 'unknown', version, result);
  };

  if (node !== 'pwa') return execute();
  try { return await runWithReleasePwaTraffic(env, execute); }
  catch (error) {
    try { version = readGraphContext(env).input.version; } catch { /* preserve empty version when context itself is invalid */ }
    return finishNode(node, version, errorResult(error));
  }
}

if (import.meta.main) process.exitCode = await runNodeVerdict(process.argv.slice(2), process.env);
