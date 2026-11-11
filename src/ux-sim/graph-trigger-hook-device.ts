import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGraphEventBus, type GraphEvent } from '../graph-runner/graph-events.js';
import { runGraph, type GraphRunState } from '../graph-runner/runner.js';
import { dispatchGraphTriggerRun } from '../loops/graph-trigger-dispatch.js';

export type GraphSimIngress = 'schedule' | 'webhook' | 'api' | 'event' | 'manual';

export interface GraphTriggerDelivery {
  readonly ingress: Exclude<GraphSimIngress, 'manual'>;
  readonly triggerId: string;
  readonly eventId: string;
  readonly dedupeKey: string;
  readonly at: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface GraphTriggerObservation {
  readonly delivery: GraphTriggerDelivery;
  readonly starts: readonly string[];
  readonly decision: string;
  readonly runId?: string;
  readonly reason?: string;
}

export type GraphTriggerAdapter = (input: {
  readonly delivery: GraphTriggerDelivery;
  readonly start: () => Promise<GraphRunState>;
}) => Promise<{ readonly decision: string; readonly runId?: string; readonly reason?: string }>;

/** Same cron tick, webhook resend, API retry, and out-of-order event delivery. No dedupe is done by the world. */
export const graphTriggerRegistryScript: readonly GraphTriggerDelivery[] = [
  { ingress: 'schedule', triggerId: 'nightly', eventId: 'tick-1', dedupeKey: 'nightly:2026-11-10', at: '2026-11-10T06:00:00.000Z', payload: { batch: 'A' } },
  { ingress: 'schedule', triggerId: 'nightly', eventId: 'tick-1', dedupeKey: 'nightly:2026-11-10', at: '2026-11-10T06:00:01.000Z', payload: { batch: 'A' } },
  { ingress: 'webhook', triggerId: 'batch-hook', eventId: 'hook-7', dedupeKey: 'batch-7', at: '2026-11-10T06:01:00.000Z', payload: { batch: 'B' } },
  { ingress: 'webhook', triggerId: 'batch-hook', eventId: 'hook-7', dedupeKey: 'batch-7', at: '2026-11-10T06:01:02.000Z', payload: { batch: 'B' } },
  { ingress: 'api', triggerId: 'start-api', eventId: 'request-9', dedupeKey: 'request-9', at: '2026-11-10T06:02:00.000Z', payload: { batch: 'C' } },
  { ingress: 'api', triggerId: 'start-api', eventId: 'request-9-retry', dedupeKey: 'request-9', at: '2026-11-10T06:02:03.000Z', payload: { batch: 'C' } },
  { ingress: 'event', triggerId: 'batch-closed', eventId: 'event-12', dedupeKey: 'batch-12', at: '2026-11-10T06:03:00.000Z', payload: { sequence: 12 } },
  { ingress: 'event', triggerId: 'batch-closed', eventId: 'event-11', dedupeKey: 'batch-11', at: '2026-11-10T06:03:01.000Z', payload: { sequence: 11 } },
  { ingress: 'event', triggerId: 'batch-closed', eventId: 'event-12', dedupeKey: 'batch-12', at: '2026-11-10T06:03:02.000Z', payload: { sequence: 12 } },
];

/** Reuses the real runner, fake ingress/clock, and event collector below; adapter owns all registry decisions. */
export function createGraphTriggerRegistryWorld(source: string) {
  const device = createGraphTriggerHookDevice(source);
  const observations: GraphTriggerObservation[] = [];
  return {
    observations,
    events: device.events,
    calls: device.calls,
    async deliver(delivery: GraphTriggerDelivery, adapter: GraphTriggerAdapter): Promise<GraphTriggerObservation> {
      device.advanceTo(delivery.at);
      const starts: string[] = [];
      const result = await adapter({
        delivery,
        start: async () => {
          const run = await device.fire(delivery.ingress, { ...delivery.payload, eventId: delivery.eventId, dedupeKey: delivery.dedupeKey });
          starts.push(run.runId);
          return run;
        },
      });
      const observation = { delivery, starts, ...result };
      observations.push(observation);
      return observation;
    },
    async play(adapter: GraphTriggerAdapter): Promise<readonly GraphTriggerObservation[]> {
      for (const delivery of graphTriggerRegistryScript) await this.deliver(delivery, adapter);
      return observations;
    },
    close: () => device.close(),
  };
}

/** The graph and runner are real. Only the clock, ingress and outgoing subscriber are simulated. */
export function createGraphTriggerHookDevice(source: string, options: {
  readonly commandResult?: { readonly stdout: string; readonly exitCode: number };
  readonly initialTime?: string;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'graph-trigger-hook-sim-'));
  const graphDir = join(root, 'graphs');
  mkdirSync(graphDir);
  const graphPath = join(graphDir, 'fixture.yaml');
  const stateRoot = join(root, 'state');
  writeFileSync(graphPath, source);
  writeFileSync(join(graphDir, 'recipes.yaml'), 'work:\n  command: simulated-work\n');
  const events: GraphEvent[] = [];
  const calls: Array<{ ingress: GraphSimIngress; at: string; input: unknown }> = [];
  let clock = new Date(options.initialTime ?? '2026-11-09T06:00:00.000Z');
  const bus = createGraphEventBus({ now: () => new Date(clock) });
  bus.subscribe(event => { events.push(event); });
  let runs = 0;
  let registrations = 0;
  let activeRunId: string | undefined;
  const initialRunningSnapshots = new Map<string, GraphRunState>();
  return {
    root, graphPath, stateRoot, events, calls, eventBus: bus,
    now: () => new Date(clock),
    advanceTo(value: string) { clock = new Date(value); },
    async fire(ingress: GraphSimIngress, input?: Record<string, unknown>, runId?: string): Promise<GraphRunState> {
      calls.push({ ingress, at: clock.toISOString(), input });
      runs += 1;
      return runGraph(graphPath, {
        runId: runId ?? `sim-${runs}`,
        eventNow: () => new Date(clock),
        input,
        eventBus: bus,
        quiet: true,
        deps: {
          root,
          releaseGraphEventAdapters: false,
          runBash: async () => ({ stdout: options.commandResult?.stdout ?? '{"outcome":"ok"}',
            stderr: '', exitCode: options.commandResult?.exitCode ?? 0 }),
        },
      });
    },
    async deliver(ingress: GraphSimIngress, identity: { triggerId: string; dedupeKey: string; graphId: string }, input?: Record<string, unknown>) {
      calls.push({ ingress, at: clock.toISOString(), input });
      const graphId = identity.graphId;
      return dispatchGraphTriggerRun({ ...identity, graphPath, payload: input }, {
        registryRoot: stateRoot, stateRoot, runRoot: stateRoot,
        createRunId: () => activeRunId = `sim-${++registrations}`,
        eventNow: () => new Date(clock),
        graphRunOptions: { eventBus: bus, quiet: true, deps: {
          releaseGraphEventAdapters: false,
          runBash: async () => ({ stdout: options.commandResult?.stdout ?? '{"outcome":"ok"}',
            stderr: '', exitCode: options.commandResult?.exitCode ?? 0 }),
          beforeNode: () => {
            if (!activeRunId || initialRunningSnapshots.has(activeRunId)) return;
            const path = join(stateRoot, 'graph-runs', graphId, `${activeRunId}.json`);
            const state = JSON.parse(readFileSync(path, 'utf8')) as GraphRunState;
            if (state.status === 'running' && state.path.length === 0 && state.nodes.length === 0)
              initialRunningSnapshots.set(state.runId, state);
          },
        } },
      });
    },
    restoreInitialRunningSnapshot(runId: string) {
      const snapshot = initialRunningSnapshots.get(runId);
      if (!snapshot) throw new Error(`graph trigger device has no initial running snapshot: ${runId}`);
      writeFileSync(snapshot.statePath, JSON.stringify(snapshot, null, 2) + '\n');
    },
    close() { rmSync(root, { recursive: true, force: true }); },
  };
}
