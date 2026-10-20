import { readFileSync } from 'node:fs';
import { passJourneyNode, type JourneyObservationNodeId } from '../../src/self-dev/graph-journey-nodes.js';
import type { GoalType } from '../../src/self-implement/goal-author.js';

type StepObservation = {
  outcome?: unknown;
  data?: Record<string, unknown>;
};
type JourneyContext = {
  observations?: Record<string, StepObservation>;
  substrate?: unknown;
  runId?: unknown;
  goalId?: unknown;
  goalType?: GoalType;
};
type UnitId = 'entry' | 'dispatch-pod' | 'author' | 'pr';
type UnitResult = {
  outcome: 'done' | 'needs-human' | 'failed';
  result: { unit: UnitId; observed: boolean; observations: Record<string, string>; reason?: string };
  evidence: { source: 'existing-harness-observation'; nodes: string[] };
};

const STEPS: Record<UnitId, readonly string[]> = {
  entry: ['intake', 'queue', 'launch-gate'],
  'dispatch-pod': ['dispatch', 'pool-admit', 'image-sync', 'credential-refresh'],
  author: ['author'],
  pr: ['open-pr'],
};

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Record only events that the existing execution path supplied; never infer a successful step. */
export function observeTaJourneyUnit(unit: UnitId, context: JourneyContext): UnitResult {
  const supplied = context.observations ?? {};
  const steps = STEPS[unit];
  const outcomes: Record<string, string> = {};
  const missing: string[] = [];

  for (const node of steps) {
    if (unit === 'dispatch-pod' && node !== 'dispatch' && context.substrate === 'local') continue;
    const observation = supplied[node];
    const outcome = stringValue(observation?.outcome);
    if (!outcome) {
      // A direct intake never enters the queue. Every other missing step is unresolved evidence.
      if (unit === 'entry' && node === 'queue' && outcomes.intake === 'direct') continue;
      missing.push(node);
      continue;
    }
    outcomes[node] = outcome;
    const helperNode = node as JourneyObservationNodeId;
    passJourneyNode(helperNode, {
      provenance: unit === 'author' ? 'authoring-start' : 'ta-journey-observation-wrapper',
      ...(stringValue(context.runId) ? { runId: stringValue(context.runId) } : {}),
      ...(context.goalType ? { goalType: context.goalType } : {}),
      data: {
        ...observation.data,
        ...(stringValue(context.goalId) ? { goalId: stringValue(context.goalId) } : {}),
        ...(unit === 'author' ? { phase: 'front' } : {}),
      },
      outcome,
    });
  }

  const values = Object.values(outcomes);
  if (values.some(value => value === 'failed' || value === 'error')) return {
    outcome: 'failed',
    result: { unit, observed: true, observations: outcomes, reason: 'existing-step-failed' },
    evidence: { source: 'existing-harness-observation', nodes: Object.keys(outcomes) },
  };

  if (missing.length > 0) return {
    outcome: 'needs-human',
    result: { unit, observed: false, observations: outcomes, reason: `missing-observation:${missing.join(',')}` },
    evidence: { source: 'existing-harness-observation', nodes: Object.keys(outcomes) },
  };

  const accepted: Record<string, readonly string[]> = {
    intake: ['direct', 'queued'],
    queue: ['launched'],
    'launch-gate': ['pass'],
    dispatch: ['fresh', 'pr-source'],
    'pool-admit': ['admitted'],
    'image-sync': ['synced', 'current'],
    'credential-refresh': ['usable'],
    author: ['authored', 'done'],
    'open-pr': ['pr-opened'],
  };
  const rejected = Object.entries(outcomes).some(([node, value]) => !accepted[node]?.includes(value));
  return {
    outcome: rejected ? 'needs-human' : 'done',
    result: { unit, observed: true, observations: outcomes, ...(rejected ? { reason: 'existing-step-needs-human' } : {}) },
    evidence: { source: 'existing-harness-observation', nodes: Object.keys(outcomes) },
  };
}

if (import.meta.main) {
  const unit = process.argv[2] as UnitId;
  try {
    const path = process.env.ELANOUS_GRAPH_CONTEXT;
    if (!path) throw new Error('ELANOUS_GRAPH_CONTEXT is required');
    const graphContext = JSON.parse(readFileSync(path, 'utf8')) as { input?: { context?: JourneyContext } };
    const result = observeTaJourneyUnit(unit, graphContext.input?.context ?? {});
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ outcome: 'failed', result: { unit, observed: false, reason: error instanceof Error ? error.message : String(error) }, evidence: { source: 'existing-harness-observation', nodes: [] } })}\n`);
  }
}
