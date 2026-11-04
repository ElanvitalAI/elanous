import { appendRunLedgerEntry } from '../../self-implement/run-ledger.js';
import { publishInsideEvent } from './inside-events.js';

export const RESEARCH_GRAPH_ID = 'natural-language-research';

export type ResearchGraphEvent =
  | { type: 'enter'; node: string }
  | { type: 'exit'; node: string; outcome: string }
  | { type: 'node-added'; node: string; kind: string; reason: string }
  | { type: 'edge-rerouted'; from: string; outcome: string; to: string; was: string; reason: string }
  | { type: 'priority-changed'; node: string; from: number; to: number; reason: string };

export interface ResearchRunObserver {
  event(event: ResearchGraphEvent): void;
  finish(outcome: 'completed' | 'failed'): void;
}

/** Register one natural-language research run in the same ledger read by Nexus /live-run. */
export function registerResearchRun(runId: string, deps: {
  append?: typeof appendRunLedgerEntry;
  publish?: typeof publishInsideEvent;
} = {}): ResearchRunObserver {
  const append = deps.append ?? appendRunLedgerEntry;
  const publish = deps.publish ?? publishInsideEvent;
  let finished = false;
  const emit = (event: string, data: Record<string, unknown>): void => {
    if (!runId) return;
    const record = { runId, event, data: { graphId: RESEARCH_GRAPH_ID, ...data }, timestamp: new Date().toISOString() };
    try { append(record); } catch { /* ledger failure must not suppress the live event */ }
    try { publish({ kind: 'harness-run', event, runId, ...record.data }); } catch { /* observation is fail-soft */ }
  };

  emit('start', { feature: '자연어 리서치', graphId: RESEARCH_GRAPH_ID });
  emit('graph-run-contract-resolved', { graphId: RESEARCH_GRAPH_ID });

  return {
    event(event) {
      if (finished) return;
      switch (event.type) {
        case 'enter':
          emit('pipeline-node-entry', { node: event.node, visit: 1, round: 0 });
          break;
        case 'exit':
          emit('pipeline-node-exit', { node: event.node, outcome: event.outcome });
          break;
        case 'node-added':
        case 'edge-rerouted':
        case 'priority-changed':
          emit(event.type, { ...event, decider: 'research-runtime' });
          break;
      }
    },
    finish(outcome) {
      if (finished) return;
      finished = true;
      emit('run-status', { runStatus: outcome, stage: 'research' });
    },
  };
}
