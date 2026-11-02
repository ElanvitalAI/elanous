import { spawn } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LogStore } from '../mss/logging/log-store.js';
import { stateDirSourceForChild } from '../agent/identity-env.js';
import { getTestStateRoot } from '../nexus/paths.js';

export interface GraphRuntimeOverlayEventPathResult {
  readonly status: 'done' | 'failed';
  readonly decisionObserved: boolean;
  readonly overlayApplied: boolean;
}

/** Run the real graph runtime in an isolated process, then relay its production observer event. */
export async function runGraphRuntimeOverlayEventPathDevice(stateRoot: string, runId: string, scenarioId: string): Promise<GraphRuntimeOverlayEventPathResult> {
  if (!/^[a-f0-9-]{36}$/i.test(runId)) throw new Error('graph runtime overlay simulation runId must be a UUID');
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(scenarioId)) throw new Error('graph runtime overlay simulation scenarioId is invalid');
  const rootStats = lstatSync(stateRoot);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) throw new Error('graph runtime overlay simulation state root must be a real directory');
  const isolatedRoot = realpathSync(stateRoot);
  const testRoot = getTestStateRoot();
  if (!testRoot || realpathSync(testRoot) !== isolatedRoot) throw new Error('graph runtime overlay simulation requires the active isolated test state root');
  const worker = fileURLToPath(new URL('./graph-runtime-overlay-event-path-worker.ts', import.meta.url));
  const instance = `ux-sim:${scenarioId}:${runId}`;
  const child = spawn(process.execPath, ['run', worker, isolatedRoot, runId, instance], {
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
  const payload = JSON.parse(marker.slice('MOCKDEV_GRAPH_EVENT_RESULT='.length)) as { ok: boolean };
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
  const overlayApplied = runtimeDecisions.some((entry) => Array.isArray(entry.data.applied) && entry.data.applied.includes('ux-sim-event-stream-runtime-overlay'));
  return { status: payload.ok && overlayApplied ? 'done' : 'failed', decisionObserved, overlayApplied };
}
