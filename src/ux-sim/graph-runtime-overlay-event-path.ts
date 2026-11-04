import { spawn } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LogStore } from '../mss/logging/log-store.js';
import { stateDirSourceForChild } from '../agent/identity-env.js';
import { getTestStateRoot } from '../nexus/paths.js';
import type { HarnessGraphEventWire } from '../../apps/pwa/src/nexus/client.js';

export interface GraphRuntimeOverlayEventPathResult {
  readonly status: 'done' | 'failed';
  readonly decisionObserved: boolean;
  readonly overlayApplied: boolean;
  readonly graphEvents: HarnessGraphEventWire[];
  readonly ledgerRoute: readonly { readonly from: string; readonly outcome: string; readonly to: string; readonly source: 'graph' | 'code-default'; readonly injected: boolean; readonly mockOutcome?: string }[];
}

/** Run the real graph runtime in an isolated process, then relay its production observer event. */
export async function runGraphRuntimeOverlayEventPathDevice(stateRoot: string, runId: string, scenarioId: string, goalId?: string, expectedApplied = true): Promise<GraphRuntimeOverlayEventPathResult> {
  if (!/^[a-f0-9-]{36}$/i.test(runId)) throw new Error('graph runtime overlay simulation runId must be a UUID');
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(scenarioId)) throw new Error('graph runtime overlay simulation scenarioId is invalid');
  const rootStats = lstatSync(stateRoot);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) throw new Error('graph runtime overlay simulation state root must be a real directory');
  const isolatedRoot = realpathSync(stateRoot);
  const testRoot = getTestStateRoot();
  if (!testRoot || realpathSync(testRoot) !== isolatedRoot) throw new Error('graph runtime overlay simulation requires the active isolated test state root');
  const worker = fileURLToPath(new URL('./graph-runtime-overlay-event-path-worker.ts', import.meta.url));
  const instance = `ux-sim:${scenarioId}:${runId}`;
  const effectiveGoalId = goalId ?? (scenarioId === 'demo1104-research-arg-graph' ? undefined : 'event_stream_probe');
  const child = spawn(process.execPath, ['run', worker, isolatedRoot, runId, instance, effectiveGoalId ?? ''], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ELANOUS_STATE_DIR: isolatedRoot, ELANOUS_STATE_DIR_SOURCE: stateDirSourceForChild(isolatedRoot, process.env) },
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let outputBytes = 0;
  let outputFailure: Error | undefined;
  let timedOut = false;
  let forceKill: ReturnType<typeof setTimeout> | undefined;
  const result = await new Promise<{ status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      forceKill = setTimeout(() => child.kill('SIGKILL'), 5_000);
    }, 60_000);
    child.once('error', (error) => { clearTimeout(timeout); if (forceKill) clearTimeout(forceKill); reject(error); });
    const collectOutput = (target: Buffer[]) => (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > 8 * 1024 * 1024) {
        outputFailure = new Error('graph runtime overlay worker stdout and stderr exceeded 8 MiB total');
        child.kill('SIGTERM');
        if (!forceKill) forceKill = setTimeout(() => child.kill('SIGKILL'), 5_000);
      } else target.push(chunk);
    };
    child.stdout.on('data', collectOutput(stdout));
    child.stderr.on('data', collectOutput(stderr));
    child.once('close', (status, signal) => {
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      if (outputFailure) reject(outputFailure);
      else if (timedOut) reject(new Error('graph runtime overlay worker timed out after 60 seconds'));
      else resolve({ status, signal, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    });
  });
  if (result.status !== 0) throw new Error(`graph runtime overlay worker failed (${result.status ?? result.signal ?? 'unknown'}): ${result.stderr.slice(-2000)}`);
  const marker = result.stdout.split(/\r?\n/).find((line) => line.startsWith('MOCKDEV_GRAPH_EVENT_RESULT='));
  if (!marker) throw new Error('graph runtime overlay worker did not return its observer result');
  const payload = JSON.parse(marker.slice('MOCKDEV_GRAPH_EVENT_RESULT='.length)) as { ok: boolean; graphEvents?: HarnessGraphEventWire[]; ledgerRoute?: GraphRuntimeOverlayEventPathResult['ledgerRoute'] };
  const store = new LogStore(join(isolatedRoot, 'logs', 'logs.db'), { instance, readonly: true });
  let runtimeDecisions: Array<{ data: Record<string, unknown> }>;
  try {
    runtimeDecisions = store.query({ exactCategories: ['self-implement'], events: ['graph-overlay-decision'], instances: [instance], limit: 1000 })
      .flatMap((row) => {
        try {
          const data = JSON.parse(row.data ?? '{}') as Record<string, unknown>;
          return data.stage === 'runtime' ? [{ data }] : [];
        } catch { return []; }
      });
  } finally { store.close(); }
  const decisionObserved = runtimeDecisions.length > 0;
  const expectedOverlayId = scenarioId === 'demo1104-research-arg-graph'
    ? 'demo1104-research-arg-runtime'
    : 'ux-sim-event-stream-runtime-overlay';
  const overlayApplied = runtimeDecisions.some((entry) => Array.isArray(entry.data.applied) && entry.data.applied.includes(expectedOverlayId));
  const graphEvents = payload.graphEvents ?? [];
  const expectationMatches = expectedApplied ? overlayApplied : !overlayApplied && graphEvents.length === 0;
  const demoEventsMatch = scenarioId !== 'demo1104-research-arg-graph' || !expectedApplied || (
    graphEvents.length === 3
    && graphEvents[0]?.type === 'node-added' && graphEvents[0].node === 'fx-scenario-quantification'
    && graphEvents[1]?.type === 'edge-rerouted' && graphEvents[1].from === 'fx-scenario-quantification' && graphEvents[1].to === 'merge'
    && graphEvents[2]?.type === 'edge-rerouted' && graphEvents[2].from === 'review' && graphEvents[2].to === 'fx-scenario-quantification'
  );
  const ledgerRoute = payload.ledgerRoute ?? [];
  const demoRouteMatches = scenarioId !== 'demo1104-research-arg-graph' || (expectedApplied
    ? ledgerRoute.length === 2
      && ledgerRoute[0]?.from === 'review' && ledgerRoute[0].outcome === 'source_missing' && ledgerRoute[0].to === 'fx-scenario-quantification'
      && ledgerRoute[1]?.from === 'fx-scenario-quantification' && ledgerRoute[1].to === 'merge'
      && ledgerRoute.every((edge) => edge.source === 'graph' && edge.injected && edge.mockOutcome === 'source_missing')
    : ledgerRoute.length === 0);
  return { status: payload.ok && decisionObserved && expectationMatches && demoEventsMatch && demoRouteMatches ? 'done' : 'failed', decisionObserved, overlayApplied, graphEvents, ledgerRoute };
}
