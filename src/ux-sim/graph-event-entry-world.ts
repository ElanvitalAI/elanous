import { createGraphEventBus, type GraphEvent } from '../graph-runner/graph-events.js';
import type { GraphRunState } from '../graph-runner/runner.js';
import { createGraphTriggerHookDevice } from './graph-trigger-hook-device.js';

export interface GraphExternalEventDelivery {
  readonly eventId: string;
  readonly type: 'batch-closed';
  readonly sequence: number;
  readonly dedupeKey: string;
  readonly at: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export type GraphEventEntryAdapter = (input: {
  readonly event: GraphExternalEventDelivery;
  readonly start: () => Promise<GraphRunState>;
}) => Promise<{ readonly decision: string; readonly runId?: string; readonly reason?: string }>;

/** Arrival order differs from producer order; the final delivery is a resend of event-12. */
export const graphExternalEventScript: readonly GraphExternalEventDelivery[] = [
  { eventId: 'event-12', type: 'batch-closed', sequence: 12, dedupeKey: 'batch-12', at: '2026-11-10T08:00:00.000Z', payload: { batch: 'B-12' } },
  { eventId: 'event-11', type: 'batch-closed', sequence: 11, dedupeKey: 'batch-11', at: '2026-11-10T08:00:01.000Z', payload: { batch: 'B-11' } },
  { eventId: 'event-12', type: 'batch-closed', sequence: 12, dedupeKey: 'batch-12', at: '2026-11-10T08:00:02.000Z', payload: { batch: 'B-12' } },
];

/** External entry is adapter-owned; the real graph event bus is separately scoped to an existing run. */
export function createGraphEventEntryWorld(source: string) {
  const ingress = createGraphTriggerHookDevice(source);
  const internalBus = createGraphEventBus({ now: ingress.now });
  internalBus.registerType('batch-closed');
  const internalEvents: GraphEvent[] = [];
  internalBus.subscribe(event => { internalEvents.push(event); });
  const observations: Array<{ event: GraphExternalEventDelivery; decision: string; starts: string[]; runId?: string; reason?: string }> = [];
  const startedRuns = new Map<string, GraphRunState>();
  return {
    calls: ingress.calls,
    runnerEvents: ingress.events,
    internalEvents,
    observations,
    async deliver(event: GraphExternalEventDelivery, adapter: GraphEventEntryAdapter) {
      ingress.advanceTo(event.at);
      const starts: string[] = [];
      const decision = await adapter({ event, start: async () => {
        const run = await ingress.fire('event', { ...event.payload, eventId: event.eventId, dedupeKey: event.dedupeKey });
        starts.push(run.runId);
        startedRuns.set(run.runId, run);
        return run;
      } });
      const observation = { event, starts, ...decision };
      observations.push(observation);
      return observation;
    },
    async play(adapter: GraphEventEntryAdapter) {
      for (const event of graphExternalEventScript) await this.deliver(event, adapter);
      return observations;
    },
    async publishInsideRun(runId: string, eventId: string, sourceNodeId: string) {
      const run = startedRuns.get(runId);
      if (!run) throw new Error(`event world has no started run: ${runId}`);
      if (!run.nodes.some(node => node.nodeId === sourceNodeId && node.executed))
        throw new Error(`event world source node was not executed: ${sourceNodeId}`);
      const event = await internalBus.publish({
        graphId: run.graphId, runId: run.runId, eventId, type: 'batch-closed',
        source: { kind: 'node', nodeId: sourceNodeId }, data: { origin: 'node-subscription' },
      });
      await internalBus.flush({ graphId: run.graphId, runId: run.runId });
      return event;
    },
    close: () => ingress.close(),
  };
}
