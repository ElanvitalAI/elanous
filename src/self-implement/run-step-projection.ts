import type { RunLedgerEntry } from './run-ledger.js';

export type RunStep =
  | { seq: number; ts: string; type: 'node-enter'; node: string; visit: number }
  | { seq: number; ts: string; type: 'node-exit'; node: string; outcome: string }
  | { seq: number; ts: string; type: 'edge-taken'; from: string; to: string; via: string; condition?: string }
  | { seq: number; ts: string; type: 'node-skipped'; node: string; reason: string; condition?: string }
  | { seq: number; ts: string; type: 'node-added'; node: string; kind: string; decider: string; reason: string; trigger?: unknown; undo?: unknown }
  | { seq: number; ts: string; type: 'edge-rerouted'; from: string; outcome: string; to: string; was: string; decider: string; reason: string }
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

const STEP_EVENTS = new Set([
  'node-enter', 'node-exit', 'edge-taken', 'node-skipped',
  'node-added', 'edge-rerouted', 'unit-expanded', 'unit-collapsed',
  'pipeline-node-entry', 'pipeline-node-exit', 'graph-edge-taken',
]);
const STRUCTURAL_EVENTS = new Set(['node-added', 'edge-rerouted', 'unit-expanded', 'unit-collapsed']);

function text(data: Record<string, unknown>, key: string): string | null {
  const value = data[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function validSeq(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function stepType(entry: RunLedgerEntry): string | null {
  if (STEP_EVENTS.has(entry.event)) {
    if (entry.event === 'pipeline-node-entry') return 'node-enter';
    if (entry.event === 'pipeline-node-exit') return 'node-exit';
    if (entry.event === 'graph-edge-taken') return 'edge-taken';
    return entry.event;
  }
  if (entry.event === 'applied' && entry.data.op === 'add-node') return 'node-added';
  if (entry.event === 'applied' && entry.data.op === 'reroute') return 'edge-rerouted';
  if (entry.event === 'applied' && entry.data.op === 'zoom-in') return 'unit-expanded';
  if (entry.event === 'applied' && entry.data.op === 'collapse') return 'unit-collapsed';
  return null;
}

function projectStep(entry: RunLedgerEntry, type: string, seq: number): RunStep | string {
  const data = entry.data;
  const ts = entry.timestamp;
  if (typeof ts !== 'string' || !Number.isFinite(Date.parse(ts))) return 'timestamp missing or invalid';
  const node = text(data, 'node');
  const condition = text(data, 'condition');
  if (STRUCTURAL_EVENTS.has(type) && (!text(data, 'decider') || !text(data, 'reason'))) {
    return 'structural change requires decider and reason';
  }
  switch (type) {
    case 'node-enter': {
      const visit = data.visit;
      return node && validSeq(visit) ? { seq, ts, type, node, visit } : 'node-enter requires node and positive visit';
    }
    case 'node-exit': {
      const outcome = text(data, 'outcome');
      return node && outcome ? { seq, ts, type, node, outcome } : 'node-exit requires node and outcome';
    }
    case 'edge-taken': {
      const from = text(data, 'from');
      const to = text(data, 'taken') ?? text(data, 'to');
      const via = text(data, 'via') ?? (entry.event === 'graph-edge-taken' ? data.source === 'graph' ? 'outcome' : 'fallback' : null);
      return from && to && via ? { seq, ts, type, from, to, via, ...(condition ? { condition } : {}) } : 'edge-taken requires from, to and via';
    }
    case 'node-skipped': {
      const reason = text(data, 'reason');
      return node && reason ? { seq, ts, type, node, reason, ...(condition ? { condition } : {}) } : 'node-skipped requires node and reason';
    }
    case 'node-added': {
      const kind = text(data, 'kind');
      return node && kind ? { seq, ts, type, node, kind, decider: text(data, 'decider')!, reason: text(data, 'reason')!, ...(data.trigger === undefined ? {} : { trigger: data.trigger }), ...(data.undo === undefined ? {} : { undo: data.undo }) } : 'node-added requires node and kind';
    }
    case 'edge-rerouted': {
      const from = text(data, 'from');
      const outcome = text(data, 'outcome');
      const to = text(data, 'to');
      const was = text(data, 'was');
      return from && outcome && to && was ? { seq, ts, type, from, outcome, to, was, decider: text(data, 'decider')!, reason: text(data, 'reason')! } : 'edge-rerouted requires from, outcome, to and was';
    }
    case 'unit-expanded': {
      const unit = text(data, 'unit') ?? text(data, 'into');
      const childRunId = text(data, 'childRunId');
      const resolution = data.resolution;
      return node && unit && childRunId && typeof resolution === 'number' && Number.isSafeInteger(resolution) && resolution >= 0
        ? { seq, ts, type, node, unit, childRunId, resolution, decider: text(data, 'decider')!, reason: text(data, 'reason')! }
        : 'unit-expanded requires node, unit, childRunId and resolution';
    }
    case 'unit-collapsed': {
      const resolution = data.resolution;
      return node && typeof resolution === 'number' && Number.isSafeInteger(resolution) && resolution >= 0
        ? { seq, ts, type, node, resolution, decider: text(data, 'decider')!, reason: text(data, 'reason')! }
        : 'unit-collapsed requires node and resolution';
    }
    default: return 'unrecognized step';
  }
}

/** Pure projection of already-read JSONL records; never guesses a sequence from timestamps or line positions. */
export function projectRunLedgerSteps(runId: string, entries: readonly RunLedgerEntry[]): RunStepProjection {
  const steps: RunStep[] = [];
  const violations: { seq: number | null; reason: string }[] = [];
  const seen = new Set<number>();
  let graphId: string | null = null;
  let version: string | null = null;
  let variantHash: string | null = null;
  for (const entry of entries) {
    if (entry.runId !== runId) continue;
    graphId = text(entry.data, 'graphId') ?? graphId;
    version = text(entry.data, 'graphVersion') ?? version;
    variantHash = text(entry.data, 'variantHash') ?? variantHash;
    const type = stepType(entry);
    if (!type) continue;
    const topLevelSeq = (entry as RunLedgerEntry & { seq?: unknown }).seq;
    const seq = topLevelSeq ?? entry.data.seq;
    if (topLevelSeq !== undefined && entry.data.seq !== undefined && topLevelSeq !== entry.data.seq) {
      violations.push({ seq: validSeq(topLevelSeq) ? topLevelSeq : null, reason: 'conflicting step seq' });
      continue;
    }
    if (!validSeq(seq)) {
      violations.push({ seq: null, reason: 'step requires positive safe-integer seq' });
      continue;
    }
    if (seen.has(seq)) {
      violations.push({ seq, reason: 'duplicate step seq' });
      continue;
    }
    seen.add(seq);
    const step = projectStep(entry, type, seq);
    if (typeof step === 'string') violations.push({ seq, reason: step });
    else steps.push(step);
  }
  steps.sort((a, b) => a.seq - b.seq);
  return { runId, graph: { graphId, version, variantHash }, steps, complete: violations.length === 0, unreadable: violations.length, violations };
}
