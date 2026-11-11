import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYaml, parseAllDocuments } from 'yaml';
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

export interface GraphTriggerEvent {
  readonly graphId: string;
  readonly runId: string;
  readonly eventId: string;
  readonly sequence: number;
  readonly type: string;
  readonly emittedAt: string;
  readonly source: { readonly kind: 'runner' | 'node'; readonly nodeId?: string };
  readonly data?: Readonly<Record<string, unknown>>;
}

interface DeclaredEventTarget { graphId: string; graphPath: string; from: string; on: string }

function graphYamlFiles(directory: string): string[] {
  const entries = readdirSync(directory, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return graphYamlFiles(path);
    return entry.isFile() && /\.ya?ml$/i.test(entry.name) ? [path] : [];
  });
}

function declaredEventTargets(root: string): DeclaredEventTarget[] {
  const targets: DeclaredEventTarget[] = [];
  for (const graphPath of graphYamlFiles(join(root, 'graphs'))) {
    const documents = parseAllDocuments(readFileSync(graphPath, 'utf8'));
    for (const document of documents) {
      if (document.errors.length > 0) throw document.errors[0];
      const value: unknown = document.toJS();
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const graph = value as Record<string, unknown>;
      const triggers = graph.triggers;
      if (!triggers || typeof triggers !== 'object' || Array.isArray(triggers)) continue;
      const trigger = (triggers as Record<string, unknown>).event;
      if (trigger === undefined) continue;
      if (!trigger || typeof trigger !== 'object' || Array.isArray(trigger))
        throw new Error(`invalid graph event trigger declaration: ${graphPath}`);
      const declaration = trigger as Record<string, unknown>;
      if (typeof graph.graph_id !== 'string' || !graph.graph_id.trim() ||
          typeof declaration.from !== 'string' || !declaration.from.trim() ||
          typeof declaration.on !== 'string' || !declaration.on.trim())
        throw new Error(`invalid graph event trigger declaration: ${graphPath}`);
      targets.push({ graphId: graph.graph_id, graphPath, from: declaration.from, on: declaration.on });
    }
  }
  return targets;
}

/** Route real graph events to declared target graphs; the durable trigger registry deduplicates redelivery. */
export async function dispatchGraphEventToDeclaredTargets(event: GraphTriggerEvent, options: {
  graphRoot: string;
  registryRoot: string;
  stateRoot: string;
  now?: () => number;
  eventNow?: () => Date;
}): Promise<DispatchedGraphTriggerRun[]> {
  if (!event.eventId.trim() || !event.graphId.trim() || !event.type.trim())
    throw new Error('graph event routing requires graphId, type, and eventId');
  const results: DispatchedGraphTriggerRun[] = [];
  const dedupeKey = `${event.graphId}:${event.runId}:${event.eventId}`;
  for (const target of declaredEventTargets(resolve(options.graphRoot))) {
    if (target.from !== event.graphId || target.on !== event.type) continue;
    results.push(await dispatchGraphTriggerRun({
      graphId: target.graphId, graphPath: target.graphPath,
      triggerId: `event:${target.from}:${target.on}:${target.graphId}`, dedupeKey,
      payload: { graphEvent: event },
    }, { registryRoot: options.registryRoot, stateRoot: options.stateRoot, runRoot: options.stateRoot,
      ...(options.now ? { now: options.now } : {}), ...(options.eventNow ? { eventNow: options.eventNow } : {}),
      graphRunOptions: { quiet: true, routeGraphEvents: false },
    }));
  }
  return results;
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
  graphRunOptions?: Pick<GraphRunOptions, 'eventBus' | 'quiet' | 'deps' | 'routeGraphEvents'>;
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
