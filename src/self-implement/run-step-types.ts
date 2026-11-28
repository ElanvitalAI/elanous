export type RunStep =
  | { seq: number; ts: string; type: 'node-enter'; node: string; visit: number }
  | { seq: number; ts: string; type: 'node-exit'; node: string; outcome: string }
  | { seq: number; ts: string; type: 'edge-taken'; from: string; to: string; via: string; condition?: string }
  | { seq: number; ts: string; type: 'node-skipped'; node: string; reason: string; condition?: string }
  | { seq: number; ts: string; type: 'node-added'; node: string; kind: string; decider: string; reason: string; trigger?: unknown; undo?: unknown; source?: string; injected?: boolean; scene?: string; demo1104Scene?: string; mockOutcome?: string }
  | { seq: number; ts: string; type: 'edge-rerouted'; from: string; outcome: string; to: string; was: string; decider: string; reason: string; source?: string; injected?: boolean; scene?: string; demo1104Scene?: string; mockOutcome?: string }
  | { seq: number; ts: string; type: 'priority-changed'; node: string; from: number; to: number; decider: string; reason: string }
  | { seq: number; ts: string; type: 'unit-expanded'; node: string; unit: string; childRunId: string; resolution: number; decider: string; reason: string }
  | { seq: number; ts: string; type: 'unit-collapsed'; node: string; resolution: number; decider: string; reason: string };

export interface RunStepProjection {
  runId: string;
  graph: { graphId: string | null; version: string | null; variantHash: string | null };
  steps: readonly RunStep[];
  complete: boolean;
  /** Number of recognized steps whose source record could not be projected. */
  unreadable: number;
  /** Source sequence and reason for every rejected or duplicate step. */
  violations: readonly { seq: number | null; reason: string }[];
}
