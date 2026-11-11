import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export type GateEvidenceLevel = 'unit' | 'package' | 'live' | 'unknown';
export interface GateCorrelationContext {
  runId: string;
  invocation: string;
  batch: string;
  shard: string | number | null;
  attempt: string | number | null;
  phase: string;
  host: string | null;
  podJob: string | null;
  file: string | null;
  evidenceLevel: GateEvidenceLevel;
}

const contextStorage = new AsyncLocalStorage<GateCorrelationContext>();
const processInvocation = randomUUID();
const evidenceLevels = new Set<GateEvidenceLevel>(['unit', 'package', 'live']);
export const GATE_HEARTBEAT_INTERVAL_MS = 60_000;
const isGateCategory = (category: string) => category === 'release.gate' || category.startsWith('release.gate.')
  || category === 'release-loop.gate' || category.startsWith('release-loop.gate.');

export function createGateCorrelationContext(input: Partial<GateCorrelationContext> & { runId?: string | null } = {}): GateCorrelationContext {
  const runId = input.runId || process.env.ELANOUS_RUN_ID || process.env.ELANOUS_GRAPH_RUN_ID || 'unknown';
  const requestedLevel = input.evidenceLevel ?? process.env.ELANOUS_GATE_EVIDENCE_LEVEL as GateEvidenceLevel | undefined;
  const evidenceLevel = requestedLevel && evidenceLevels.has(requestedLevel) ? requestedLevel : 'unknown';
  return {
    runId,
    invocation: input.invocation ?? process.env.ELANOUS_GATE_INVOCATION ?? processInvocation,
    batch: input.batch ?? process.env.ELANOUS_BATCH_ID ?? 'unknown',
    shard: input.shard ?? null,
    attempt: input.attempt ?? null,
    phase: input.phase ?? 'startup',
    host: input.host !== undefined ? input.host : process.env.ELANOUS_GATE_HOST ?? null,
    podJob: input.podJob ?? null,
    file: input.file ?? null,
    evidenceLevel,
  };
}

export function withGateCorrelationContext<T>(context: GateCorrelationContext, run: () => T): T {
  // A caller may reuse an identity template across concurrent observations. Phase updates stay local to each scope.
  return contextStorage.run({ ...context }, run);
}

export function currentGateCorrelationContext(): GateCorrelationContext | undefined {
  return contextStorage.getStore();
}

/** Adds a stable, queryable correlation envelope to every release gate log record. */
export function correlateGateLog(category: string, event: string, payload: unknown): unknown {
  if (!isGateCategory(category)) return payload;
  const context = contextStorage.getStore() ?? createGateCorrelationContext();
  const data = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : payload === undefined ? {} : { value: payload };
  const phaseFromEvent = event.startsWith('phase-') && event !== 'phase-heartbeat' ? event.slice('phase-'.length) : undefined;
  if (typeof data.phase === 'string') context.phase = data.phase;
  else if (phaseFromEvent) context.phase = phaseFromEvent;
  const files = Array.isArray(data.files) ? data.files : undefined;
  return {
    ...data,
    runId: data.runId ?? context.runId,
    invocation: data.invocation ?? data.invocationId ?? context.invocation,
    batch: data.batch ?? data.batchId ?? context.batch,
    shard: data.shard ?? data.shardId ?? context.shard,
    attempt: data.attempt ?? data.attemptId ?? context.attempt,
    phase: event === 'phase-heartbeat' ? context.phase : data.phase ?? phaseFromEvent ?? context.phase,
    host: data.host !== undefined ? data.host : data.executorHost ?? data.placedOn ?? context.host,
    podJob: data.podJob ?? data.job ?? data.jobName ?? context.podJob,
    file: data.file ?? data.testFile ?? (files?.length === 1 ? files[0] : context.file),
    evidenceLevel: data.evidenceLevel ?? context.evidenceLevel,
  };
}

export interface GateHeartbeatOptions {
  intervalMs?: number;
  now?: () => number;
  schedule?: (tick: () => void, intervalMs: number) => () => void;
}

/** Emits a phase heartbeat every minute and reports a delayed/missing tick when the scheduler resumes. */
export function startGateHeartbeat(
  emit: (event: string, data: Record<string, unknown>, level?: 'info' | 'warn') => void,
  options: GateHeartbeatOptions = {},
): () => void {
  const intervalMs = options.intervalMs ?? GATE_HEARTBEAT_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const context = contextStorage.getStore();
  let lastBeat = now();
  const schedule = options.schedule ?? ((tick, interval) => {
    const timer = setInterval(tick, interval);
    timer.unref();
    return () => clearInterval(timer);
  });
  emit('phase-heartbeat', { phase: context?.phase ?? 'unknown', at: new Date(lastBeat).toISOString(), gapMs: 0,
    expectedIntervalMs: intervalMs });
  return schedule(() => {
    const at = now();
    const gapMs = Math.max(0, at - lastBeat);
    if (gapMs > intervalMs * 1.5) emit('heartbeat-interrupted', {
      phase: context?.phase ?? 'unknown', gapMs, expectedIntervalMs: intervalMs,
    }, 'warn');
    emit('phase-heartbeat', { phase: context?.phase ?? 'unknown', at: new Date(at).toISOString(), gapMs,
      expectedIntervalMs: intervalMs });
    lastBeat = at;
  }, intervalMs);
}
