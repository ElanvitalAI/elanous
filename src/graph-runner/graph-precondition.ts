import { graphContractValueMatches, type GraphCapabilityProviderDeclaration,
  type GraphContractSchema, type GraphPreconditionFillSource } from './capabilities.js';
import type { InProcessHandlerContext } from './in-process-registry.js';

export interface GraphPreconditionObservation {
  readonly phase: 'check' | 'fill' | 'blocked';
  readonly attempt: number;
  readonly missingKeys: readonly string[];
  readonly source?: GraphPreconditionFillSource;
  readonly reason?: string;
}

export interface GraphPreconditionOptions {
  readonly ownerId?: string;
  readonly appSlug?: string;
  readonly manifestDefaults?: Readonly<Record<string, unknown>>;
  readonly priorResults?: readonly Readonly<Record<string, unknown>>[];
  readonly askUser?: (input: { readonly missingKeys: readonly string[]; readonly signal: AbortSignal;
    readonly deadlineAtMs: number }) => Promise<Readonly<Record<string, unknown>> | undefined>;
  readonly deadlineAtMs: number;
  readonly signal?: AbortSignal;
  readonly observe?: (observation: GraphPreconditionObservation) => void | Promise<void>;
}

type Prepared = { readonly ok: true; readonly context: InProcessHandlerContext }
  | { readonly ok: false; readonly missing: readonly string[]; readonly reason: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const hasValue = (row: Record<string, unknown>, key: string): boolean =>
  Object.hasOwn(row, key) && row[key] !== undefined && row[key] !== null
  && !(typeof row[key] === 'string' && (row[key] as string).trim() === '');

const SAFE_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;
const AUTHORITY_KEYS = new Set(['owner', 'ownerId', 'memberId', 'requireOwner', 'appSlug']);
const EFFECT_KEYS = new Set(['action', 'approvalId', 'approvalUrl', 'approvalConfirmed',
  'requirePassingReceipt', 'receipt', 'deploymentId']);
const canFill = (key: string, source: GraphPreconditionFillSource): boolean =>
  SAFE_KEY.test(key) && !EFFECT_KEYS.has(key) && (!AUTHORITY_KEYS.has(key) || source === 'host');

function propertySchema(schema: GraphContractSchema, key: string): GraphContractSchema | undefined {
  if (!isRecord(schema.properties) || !isRecord(schema.properties[key])) return undefined;
  return schema.properties[key] as GraphContractSchema;
}

function safeValue(schema: GraphContractSchema, key: string, value: unknown): boolean {
  const property = propertySchema(schema, key);
  return !!property && graphContractValueMatches(property, value);
}

function hostValue(key: string, options: GraphPreconditionOptions): unknown {
  if (['owner', 'ownerId', 'memberId'].includes(key)) return options.ownerId;
  if (key === 'requireOwner') return options.ownerId;
  return key === 'appSlug' ? options.appSlug : undefined;
}

type AskResult = { readonly kind: 'answer'; readonly value?: Readonly<Record<string, unknown>> }
  | { readonly kind: 'failed' | 'deadline' };

async function askWithinDeadline(options: GraphPreconditionOptions, missingKeys: readonly string[]): Promise<AskResult> {
  if (!options.askUser) return { kind: 'answer' };
  if (options.signal?.aborted) return { kind: 'deadline' };
  const remaining = Math.max(0, options.deadlineAtMs - Date.now());
  if (remaining === 0) return { kind: 'deadline' };
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  const timer = setTimeout(abort, remaining);
  let onAbort = () => {};
  try {
    const aborted = new Promise<AskResult>(resolve => {
      onAbort = () => resolve({ kind: 'deadline' });
      controller.signal.addEventListener('abort', onAbort, { once: true });
      if (controller.signal.aborted) onAbort();
    });
    const asked = (async (): Promise<AskResult> => {
      if (controller.signal.aborted) return { kind: 'deadline' };
      try { return { kind: 'answer', value: await options.askUser!({ missingKeys,
        signal: controller.signal, deadlineAtMs: options.deadlineAtMs }) }; }
      catch { return { kind: 'failed' }; }
    })();
    const result = await Promise.race([asked, aborted]);
    return result;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', onAbort);
    controller.abort();
  }
}

/** Two bounded check/fill/recheck rounds; only declared, typed data may enter nodeInput. */
export async function prepareGraphPreconditions(provider: GraphCapabilityProviderDeclaration,
  context: InProcessHandlerContext, inputSchema: GraphContractSchema,
  options: GraphPreconditionOptions): Promise<Prepared> {
  const original = context.nodeInput === undefined ? context.input : context.nodeInput;
  const input: Record<string, unknown> = isRecord(original) ? { ...original } : {};
  const required = provider.requires ?? [];
  if (required.some(key => !SAFE_KEY.test(key) || ['constructor', 'prototype', '__proto__'].includes(key)))
    return { ok: false, missing: required, reason: 'precondition-invalid-key' };
  const missing = () => required.filter(key => !hasValue(input, key));
  const sourceOrder: readonly GraphPreconditionFillSource[] = ['host', 'manifest', 'prior', 'ask_user'];
  const blocked = async (reason: string, attempt: number, absent: readonly string[]): Promise<Prepared> => {
    await options.observe?.({ phase: 'blocked', attempt, missingKeys: absent, reason });
    return { ok: false, missing: absent, reason };
  };
  for (const key of Object.keys(input)) {
    if (AUTHORITY_KEYS.has(key) && (!hasValue(input, key) || input[key] !== hostValue(key, options)))
      return blocked('precondition-authority-binding-mismatch', 0, [key]);
  }
  if (!required.length) return { ok: true, context };
  for (let attempt = 0; attempt <= 2; attempt++) {
    const absent = missing();
    await options.observe?.({ phase: 'check', attempt, missingKeys: absent });
    if (absent.length === 0) return { ok: true, context: context.nodeInput === undefined
      ? { ...context, input } : { ...context, nodeInput: input } };
    if (attempt === 2 || options.signal?.aborted || Date.now() >= options.deadlineAtMs) {
      const reason = options.signal?.aborted ? 'precondition-aborted'
        : Date.now() >= options.deadlineAtMs ? 'precondition-deadline' : 'precondition-missing';
      return blocked(reason, attempt, absent);
    }
    for (const source of sourceOrder) {
      const candidates = missing().filter(key => canFill(key, source) && provider.fill?.[key]?.includes(source));
      if (!candidates.length) continue;
      const asked = source === 'ask_user' ? await askWithinDeadline(options, candidates) : undefined;
      if (asked?.kind === 'failed' || asked?.kind === 'deadline')
        return blocked(asked.kind === 'failed' ? 'precondition-ask-failed' : 'precondition-deadline', attempt + 1, candidates);
      if (asked?.kind === 'answer' && asked.value !== undefined && !isRecord(asked.value))
        return blocked('precondition-ask-invalid', attempt + 1, candidates);
      for (const key of candidates) {
        let value: unknown;
        if (source === 'host') value = hostValue(key, options);
        else if (source === 'manifest') value = options.manifestDefaults?.[key];
        else if (source === 'prior') value = [...(options.priorResults ?? [])].reverse()
          .find(row => Object.hasOwn(row, key))?.[key];
        else value = asked?.kind === 'answer' && isRecord(asked.value) ? asked.value[key] : undefined;
        if (value === undefined) continue;
        if (value === null || typeof value === 'string' && !value.trim() || !safeValue(inputSchema, key, value))
          return blocked(`precondition-invalid-${source}`, attempt + 1, [key]);
        input[key] = structuredClone(value);
        await options.observe?.({ phase: 'fill', attempt: attempt + 1, missingKeys: [key], source });
      }
    }
  }
  throw new Error('unreachable precondition round');
}
