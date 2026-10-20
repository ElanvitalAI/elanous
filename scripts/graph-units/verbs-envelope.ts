import { readFileSync } from 'node:fs';

type JsonMap = Record<string, unknown>;
interface GraphContext { readonly nodeId?: string; readonly input: unknown; readonly outputs: Record<string, unknown> }

function record(value: unknown): JsonMap {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonMap : {};
}

function firstValue(context: GraphContext, key: string): unknown {
  const input = record(context.input);
  if (Object.hasOwn(input, key) && input[key] !== undefined && input[key] !== null) return input[key];
  for (const output of Object.values(context.outputs ?? {})) {
    const value = record(output)[key];
    if (value !== undefined && value !== null) return value;
  }
  return null;
}

const VERIFY_INPUTS = ['worktree', 'changed-files', 'diff', 'review-intent', 'must-fix', 'gate-log'] as const;
const VERIFY_STARTS = new Set(['gate', 'review', 'rework']);

export interface MakeDocInputs {
  readonly goal: string;
  readonly worktree: unknown;
  readonly branch: unknown;
  readonly 'review-intent': unknown;
  readonly 'head-sha': unknown;
  readonly 'base-branch': unknown;
  readonly prior: unknown;
}

/** Converts the public make-doc envelope into the existing document-loop recipe contract. */
export function unpackMakeDocEnvelope(envelope: { readonly ask?: unknown; readonly context?: unknown; readonly prior?: unknown }): MakeDocInputs {
  const context = record(envelope.context);
  const contextGoal = context.goal;
  const ask = typeof envelope.ask === 'string' ? envelope.ask : '';
  const reviewIntent = context['review-intent'] ?? (ask.trim() ? ask : null);
  const goal = typeof contextGoal === 'string' && contextGoal.trim() ? contextGoal : ask;
  return {
    goal,
    worktree: context.worktree ?? null,
    branch: context.branch ?? null,
    'review-intent': reviewIntent,
    'head-sha': context['head-sha'] ?? null,
    'base-branch': context['base-branch'] ?? null,
    prior: envelope.prior ?? null,
  };
}

/** Keeps the make-doc outputs present on every declared exit. */
export function buildMakeDocOutput(context: GraphContext): JsonMap {
  const draft = record(context.outputs?.['document-draft']);
  const input = record(context.input);
  const prior = record(input.prior);
  const priorEvidence = record(prior.evidence);
  const inputEvidence = record(input.evidence);
  const draftEvidence = record(draft.evidence);
  const evidence = { ...priorEvidence, ...inputEvidence, ...draftEvidence };
  if (prior.result !== undefined) evidence['prior-result'] = prior.result;
  return {
    result: draft.result ?? draft.summary ?? input.result ?? null,
    evidence,
  };
}

/** Selects a verify entry while keeping every unit input explicit at the call boundary. */
export function buildVerifyEnvelope(context: GraphContext): JsonMap {
  const input = record(context.input);
  const detail = record(input.context);
  const prior = record(input.prior);
  const priorResult = record(prior.result);
  const priorEvidence = record(prior.evidence);
  const start = detail.start_at ?? detail.startAt;
  const startAt = typeof start === 'string' && VERIFY_STARTS.has(start) ? start : 'gate';
  const envelope: JsonMap = {
    outcome: startAt,
    ...Object.fromEntries(VERIFY_INPUTS.map(key => [key, detail[key] ?? prior[key] ?? priorEvidence[key] ?? priorResult[key] ?? firstValue(context, key)])),
  };
  if (detail['review-intent'] == null && typeof input.ask === 'string' && input.ask.trim()) envelope['review-intent'] = input.ask;
  return envelope;
}

/** Emits the complete verify output contract from whichever routes ran. */
export function buildVerifyOutput(context: GraphContext, outcome: 'done' | 'rework' | 'needs-human' | 'failed'): JsonMap {
  const input = record(context.input);
  const prior = record(input.prior);
  const priorEvidence = record(prior.evidence);
  const outputsByNode = record(context.outputs);
  const stageOrder = outcome === 'done'
    ? ['prepare', 'rework-loop', 'gate', 'review']
    : outcome === 'rework'
      ? ['prepare', 'gate', 'review', 'rework-loop']
      : (() => {
        const source = ['prepare', 'gate', 'review', 'rework-loop']
          .find(node => record(outputsByNode[node]).outcome === outcome);
        if (source === 'gate') return ['prepare', 'review', 'rework-loop', 'gate'];
        if (source === 'review') return ['prepare', 'rework-loop', 'gate', 'review'];
        if (source === 'rework-loop') return ['prepare', 'gate', 'review', 'rework-loop'];
        return ['prepare'];
      })();
  const outputs = stageOrder.map(node => record(outputsByNode[node]));
  const evidence = { ...priorEvidence };
  for (const output of outputs) Object.assign(evidence, record(output.evidence));
  const latest = (key: string, aliases: readonly string[] = []): unknown => {
    let value: unknown = priorEvidence[key] ?? null;
    for (const output of outputs) {
      const nodeValue = [key, ...aliases].map(name => output[name]).find(candidate => candidate !== undefined && candidate !== null);
      const evidenceValue = record(output.evidence)[key];
      if (nodeValue !== undefined) value = nodeValue;
      else if (evidenceValue !== undefined && evidenceValue !== null) value = evidenceValue;
    }
    return value;
  };
  return {
    result: outcome,
    evidence: {
      ...evidence,
      ...(prior.result === undefined ? {} : { 'prior-result': prior.result }),
      'review-summary': latest('review-summary', ['review_summary']),
      'must-fix': outcome === 'done' ? [] : latest('must-fix', ['must_fix']),
      'gate-log': latest('gate-log', ['gate_log']),
    },
  };
}

if (import.meta.main) {
  const contextPath = process.env.ELANOUS_GRAPH_CONTEXT;
  if (!contextPath) throw new Error('ELANOUS_GRAPH_CONTEXT is required');
  const context = JSON.parse(readFileSync(contextPath, 'utf8')) as GraphContext;
  const mode = process.argv[2];
  const output = mode === 'make-doc-input'
    ? unpackMakeDocEnvelope(record(context.input) as { ask?: unknown; context?: unknown; prior?: unknown })
    : mode === 'make-doc-output' ? buildMakeDocOutput(context)
      : mode === 'verify-envelope' ? buildVerifyEnvelope(context)
      : mode === 'verify-output' ? buildVerifyOutput(context, process.argv[3] as 'done' | 'rework' | 'needs-human' | 'failed') : undefined;
  if (!output) throw new Error(`unknown verbs-envelope mode: ${mode ?? '<missing>'}`);
  process.stdout.write(`${JSON.stringify(output)}\n`);
}
