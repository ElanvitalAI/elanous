import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { runGraph, type GraphRunOptions, type GraphRunState } from '../graph-runner/runner.js';
import { registerGraphTriggerRun, type GraphTriggerRunRegistration, type RegisteredGraphTriggerRun } from './registry.js';
import { claimGraphTriggerDispatchLease, GRAPH_TRIGGER_DISPATCH_LEASE_MS, GRAPH_TRIGGER_DISPATCH_RENEWAL_DIVISOR,
  releaseGraphTriggerDispatchLease, renewGraphTriggerDispatchLease, withGraphTriggerDispatchLeaseFence } from './graph-trigger-dispatch-lease.js';

export interface DispatchGraphTriggerRunInput extends GraphTriggerRunRegistration {
  graphPath: string;
  payload?: unknown;
}

export interface DispatchedGraphTriggerRun {
  registration: RegisteredGraphTriggerRun;
  claimed: boolean;
  mode?: 'start' | 'resume';
  state?: GraphRunState;
}

/** Shared trigger ingress: bind identity, claim its lease, and start or resume the corresponding graph run. */
export async function dispatchGraphTriggerRun(input: DispatchGraphTriggerRunInput, options: {
  registryRoot?: string;
  stateRoot?: string;
  runRoot?: string;
  now?: () => number;
  leaseMs?: number;
  createRunId?: () => string;
  eventNow?: () => Date;
  graphRunOptions?: Pick<GraphRunOptions, 'eventBus' | 'quiet' | 'deps'>;
} = {}): Promise<DispatchedGraphTriggerRun> {
  const graphDoc = parseYaml(readFileSync(input.graphPath, 'utf8')) as unknown;
  const actualGraphId = graphDoc && typeof graphDoc === 'object' && !Array.isArray(graphDoc)
    ? (graphDoc as Record<string, unknown>).graph_id : undefined;
  if (actualGraphId !== input.graphId)
    throw new Error(`graph trigger graph identity mismatch: ${input.graphId} != ${String(actualGraphId)}`);

  const defaultRoot = effectiveInstanceRoot();
  const registryRoot = resolve(options.registryRoot ?? defaultRoot);
  const stateRoot = resolve(options.stateRoot ?? registryRoot);
  const runRoot = resolve(options.runRoot ?? stateRoot);
  if (runRoot !== stateRoot) throw new Error('graph trigger runRoot must match its registered stateRoot');

  const registration = registerGraphTriggerRun({ triggerId: input.triggerId, dedupeKey: input.dedupeKey, graphId: input.graphId }, {
    registryRoot, stateRoot, ...(options.createRunId ? { createRunId: options.createRunId } : {}),
  });
  const leaseMs = options.leaseMs ?? GRAPH_TRIGGER_DISPATCH_LEASE_MS;
  const lease = claimGraphTriggerDispatchLease({
    triggerId: registration.triggerId, dedupeKey: registration.dedupeKey,
    graphId: registration.graphId, runId: registration.runId,
  }, {
    registryRoot, stateRoot, ...(options.now ? { now: options.now } : {}), leaseMs,
  });
  if (!lease.claimed) return { registration, claimed: false };

  const statePath = join(stateRoot, 'graph-runs', input.graphId, `${registration.runId}.json`);
  const controller = new AbortController();
  let leaseLost = false;
  // Source: keep renewal timers positive even when a test injects a very short lease window.
  const renewalMs = Math.max(1, Math.floor(leaseMs / GRAPH_TRIGGER_DISPATCH_RENEWAL_DIVISOR));
  const heartbeat = setInterval(() => {
    try {
      if (renewGraphTriggerDispatchLease(lease.lease, { ...(options.now ? { now: options.now } : {}), leaseMs })) return;
      leaseLost = true;
      controller.abort(new Error(`graph trigger dispatch lease lost: ${input.triggerId}/${input.dedupeKey}`));
    } catch (error) {
      leaseLost = true;
      controller.abort(error);
    }
  }, renewalMs);
  try {
    let saved: GraphRunState | undefined;
    if (existsSync(statePath)) {
      saved = JSON.parse(readFileSync(statePath, 'utf8')) as GraphRunState;
      if (saved.graphId !== input.graphId || saved.runId !== registration.runId)
        throw new Error(`graph trigger run identity mismatch: ${input.graphId}/${registration.runId}`);
      if (saved.status !== 'running') return { registration, claimed: true, state: saved };
    }
    const mode = saved ? 'resume' : 'start';
    const state = await runGraph(input.graphPath, {
      ...options.graphRunOptions,
      ...(mode === 'resume' ? { resumeRunId: registration.runId } : { runId: registration.runId, input: input.payload }),
      signal: controller.signal, ...(options.eventNow ? { eventNow: options.eventNow } : {}),
      deps: { ...options.graphRunOptions?.deps, root: stateRoot,
        withPersistFence: (_state, persist) => withGraphTriggerDispatchLeaseFence(lease.lease, persist,
          options.now ? { now: options.now } : {}) },
    });
    if (leaseLost) throw new Error(`graph trigger dispatch lease lost: ${input.triggerId}/${input.dedupeKey}`);
    return { registration, claimed: true, mode, state };
  } finally {
    clearInterval(heartbeat);
    releaseGraphTriggerDispatchLease(lease.lease);
  }
}
