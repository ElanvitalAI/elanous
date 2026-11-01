import type { RunLedgerEntry } from '../self-implement/run-ledger.js';
import { redactSecretText } from '../debug/log.js';

export interface ChildFirstLlmEvent {
  readonly runId: string;
  readonly event: 'child-first-llm-call' | 'child-first-tool-call';
  readonly data: Record<string, unknown>;
}

export type ChildFirstLlmWriter = (event: ChildFirstLlmEvent) => void | Promise<void>;

/** Appends one first-provider-call timeline per child run. The writer is fail-soft by contract. */
export function createChildFirstLlmRecorder(write: ChildFirstLlmWriter) {
  const started = new Set<string>();
  const responded = new Set<string>();
  const toolCalled = new Set<string>();
  return {
    async start(input: { runId: string; provider: string; model: string; accountName?: string; at?: string }): Promise<void> {
      const runId = input.runId.trim();
      if (!runId || started.has(runId)) return;
      started.add(runId);
      await write({
        runId, event: 'child-first-llm-call',
        data: { status: 'started', provider: input.provider, model: input.model,
          accountName: input.accountName ?? null, startedAt: input.at ?? new Date().toISOString() },
      });
    },
    async response(input: { runId: string; status: 'ok' | 'error'; httpStatus?: number; error?: unknown; at?: string }): Promise<void> {
      const runId = input.runId.trim();
      if (!runId || !started.has(runId) || responded.has(runId)) return;
      responded.add(runId);
      const raw = input.error instanceof Error ? input.error.message : input.error == null ? '' : String(input.error);
      const firstLine = redactSecretText(raw.split(/\r?\n/u, 1)[0] ?? '').replace(/\s+/gu, ' ').slice(0, 240);
      await write({
        runId, event: 'child-first-llm-call',
        data: { status: input.status, ...(input.httpStatus === undefined ? {} : { httpStatus: input.httpStatus }),
          ...(firstLine ? { errorFirstLine: firstLine } : {}), respondedAt: input.at ?? new Date().toISOString() },
      });
    },
    async firstToolCall(input: { runId: string; at?: string }): Promise<void> {
      const runId = input.runId.trim();
      if (!runId || !started.has(runId) || toolCalled.has(runId)) return;
      toolCalled.add(runId);
      await write({ runId, event: 'child-first-tool-call', data: { at: input.at ?? new Date().toISOString() } });
    },
  };
}

const defaultRecorder = createChildFirstLlmRecorder(async ({ runId, event, data }) => {
  try {
    const { appendRunLedgerEntry } = await import('../self-implement/run-ledger.js');
    appendRunLedgerEntry({ timestamp: new Date().toISOString(), runId, event, data } satisfies RunLedgerEntry);
  } catch { /* observation must never prevent an LLM call */ }
});

export function childRunIdForLlmObservation(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const runId = env.ELANOUS_RUN_ID?.trim();
  return runId || undefined;
}

export function recordChildFirstLlmStart(input: { provider: string; model: string; accountName?: string }): Promise<void> {
  const runId = childRunIdForLlmObservation();
  return runId ? defaultRecorder.start({ runId, ...input }) : Promise.resolve();
}

export function recordChildFirstLlmResponse(input: { status: 'ok' | 'error'; httpStatus?: number; error?: unknown }): Promise<void> {
  const runId = childRunIdForLlmObservation();
  return runId ? defaultRecorder.response({ runId, ...input }) : Promise.resolve();
}

export function recordChildFirstToolCall(): Promise<void> {
  const runId = childRunIdForLlmObservation();
  return runId ? defaultRecorder.firstToolCall({ runId }) : Promise.resolve();
}

export interface ChildFirstLlmFact {
  readonly status: 'started' | 'ok' | 'error';
  readonly provider: string;
  readonly model: string;
  readonly accountName: string | null;
  readonly startedAt: string;
  readonly respondedAt?: string;
  readonly httpStatus?: number;
  readonly errorFirstLine?: string;
  readonly firstToolCallAt?: string;
}

export function childFirstLlmFact(entries: readonly Pick<RunLedgerEntry, 'event' | 'data'>[]): ChildFirstLlmFact | undefined {
  const start = entries.find((entry) => entry.event === 'child-first-llm-call' && entry.data.status === 'started');
  if (!start || typeof start.data.provider !== 'string' || typeof start.data.model !== 'string' || typeof start.data.startedAt !== 'string') return undefined;
  const response = entries.find((entry) => entry.event === 'child-first-llm-call' && (entry.data.status === 'ok' || entry.data.status === 'error'));
  const tool = entries.find((entry) => entry.event === 'child-first-tool-call' && typeof entry.data.at === 'string');
  const status = response?.data.status === 'ok' || response?.data.status === 'error' ? response.data.status : 'started';
  return {
    status, provider: start.data.provider, model: start.data.model,
    accountName: typeof start.data.accountName === 'string' ? start.data.accountName : null,
    startedAt: start.data.startedAt,
    ...(typeof response?.data.respondedAt === 'string' ? { respondedAt: response.data.respondedAt } : {}),
    ...(typeof response?.data.httpStatus === 'number' ? { httpStatus: response.data.httpStatus } : {}),
    ...(typeof response?.data.errorFirstLine === 'string' ? { errorFirstLine: response.data.errorFirstLine } : {}),
    ...(typeof tool?.data.at === 'string' ? { firstToolCallAt: tool.data.at } : {}),
  };
}

export function childFirstLlmStatusLabel(fact: ChildFirstLlmFact): string {
  return fact.status === 'error' && fact.httpStatus !== undefined ? `error(${fact.httpStatus})` : fact.status;
}

export function childFirstLlmReportFact(entries: readonly Pick<RunLedgerEntry, 'event' | 'data'>[]): (ChildFirstLlmFact & { readonly statusLabel: string }) | undefined {
  const fact = childFirstLlmFact(entries);
  return fact ? { ...fact, statusLabel: childFirstLlmStatusLabel(fact) } : undefined;
}
