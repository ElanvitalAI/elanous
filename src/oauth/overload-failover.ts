// Launch-time codex → grok switch driven only by `llm.call` / `outcome`.
//
// #24256 read `llm.response` / `llm.stream`. Those rows do not carry
// provider + status + kind, so a launch that consulted them never saw
// overload. This module refuses every other category.
//
// Boundaries:
//   • an explicit codex child (flag or pinned config) never switches (#24183)
//   • k consecutive codex overload/5xx/rate-limit outcomes switch the next
//     child to grok before that child is spawned
//   • k later successful outcomes restore codex
//   • a 400 (kind `other`) never counts

import { logsDbPath, LogStore, type LogStoreRow } from '../mss/logging/log-store.js';
import {
  codexOverloadStreakReached,
  overloadRecovered,
  OVERLOAD_FAILOVER_STREAK,
  type LlmCallOutcome,
  type LlmCallOutcomeKind,
} from '../session-runtime/retry-policy.js';
import { lookupLlmTierSpec } from '../model-tier/llm-tier-map.js';

export const LLM_CALL_CATEGORY = 'llm.call';
export const LLM_CALL_EVENT = 'outcome';

const KINDS = new Set<LlmCallOutcomeKind>(['ok', 'overloaded', '5xx', 'rate-limit', 'other']);

export interface OverloadFailoverLaunchInput {
  /** True when the launch named codex (flag or pinned childLlm). */
  readonly codexExplicit: boolean;
  /** Provider the launch would have used before this gate. */
  readonly provider: string;
  readonly model?: string;
  readonly outcomes: readonly LlmCallOutcome[];
  readonly streak?: number;
  /** grok may be selected. Unknown is not a reason to stay on a hot codex. */
  readonly grokAvailable?: boolean;
}

export interface OverloadFailoverLaunchDecision {
  readonly provider: string;
  readonly model?: string;
  readonly switched: boolean;
  readonly why: 'explicit-codex' | 'not-codex' | 'streak' | 'recovered' | 'below-streak' | 'grok-unavailable';
}

export function parseLlmCallOutcome(row: Pick<LogStoreRow, 'category' | 'event' | 'data'>): LlmCallOutcome | undefined {
  if (row.category !== LLM_CALL_CATEGORY || row.event !== LLM_CALL_EVENT || !row.data) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(row.data); } catch { return undefined; }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const rec = parsed as { provider?: unknown; status?: unknown; kind?: unknown };
  if (typeof rec.provider !== 'string' || rec.provider.length === 0) return undefined;
  if (typeof rec.status !== 'number' || !Number.isFinite(rec.status)) return undefined;
  if (typeof rec.kind !== 'string' || !KINDS.has(rec.kind as LlmCallOutcomeKind)) return undefined;
  return { provider: rec.provider, status: rec.status, kind: rec.kind as LlmCallOutcomeKind };
}

/** Newest-last. Rows that are not `llm.call`/`outcome` are dropped, never guessed. */
export function outcomesFromCallRows(rows: readonly (Pick<LogStoreRow, 'category' | 'event' | 'data' | 'ts_ms'> & { id?: number })[]): LlmCallOutcome[] {
  // The store returns newest first; calls in the same millisecond keep that order unless ties break on row id.
  return [...rows]
    .filter((row) => row.category === LLM_CALL_CATEGORY && row.event === LLM_CALL_EVENT)
    .sort((a, b) => a.ts_ms - b.ts_ms || (a.id ?? 0) - (b.id ?? 0))
    .flatMap((row) => {
      const parsed = parseLlmCallOutcome(row);
      return parsed ? [parsed] : [];
    });
}

export function readLlmCallOutcomes(opts: {
  dbPath?: string;
  sinceMs?: number;
  limit?: number;
  open?: (path: string) => Pick<LogStore, 'query' | 'close'>;
} = {}): LlmCallOutcome[] {
  const path = opts.dbPath ?? logsDbPath();
  const open = opts.open ?? ((dbPath: string) => LogStore.openReadOnly(dbPath));
  let store: Pick<LogStore, 'query' | 'close'> | undefined;
  try {
    store = open(path);
    const rows = store.query({
      exactCategories: [LLM_CALL_CATEGORY],
      events: [LLM_CALL_EVENT],
      ...(opts.sinceMs !== undefined ? { sinceMs: opts.sinceMs } : {}),
      limit: opts.limit ?? 50,
    });
    return outcomesFromCallRows(rows);
  } catch {
    return [];
  } finally {
    try { store?.close(); } catch { /* a missing store is "no sample", not a launch failure */ }
  }
}

export function decideOverloadFailoverLaunch(input: OverloadFailoverLaunchInput): OverloadFailoverLaunchDecision {
  const streak = input.streak ?? OVERLOAD_FAILOVER_STREAK;
  const base = { provider: input.provider, ...(input.model !== undefined ? { model: input.model } : {}) };
  if (input.codexExplicit) return { ...base, switched: false, why: 'explicit-codex' };
  const onCodex = input.provider === 'openai-codex' || input.provider === 'codex';
  if (!onCodex) return { ...base, switched: false, why: 'not-codex' };
  if (overloadRecovered(input.outcomes, streak)) return { ...base, switched: false, why: 'recovered' };
  if (!codexOverloadStreakReached(input.outcomes, streak)) return { ...base, switched: false, why: 'below-streak' };
  if (input.grokAvailable === false) return { ...base, switched: false, why: 'grok-unavailable' };
  return {
    provider: 'grok',
    model: lookupLlmTierSpec('grok', 'better').model,
    switched: true,
    why: 'streak',
  };
}

/** Apply the gate to a not-yet-pinned child selection. Explicit codex is left untouched. */
export function applyOverloadFailoverToChild<T extends { provider: string; model: string; source: 'flag' | 'config' }>(
  selection: T | undefined,
  opts: {
    codexExplicit: boolean;
    outcomes: readonly LlmCallOutcome[];
    grokAvailable?: boolean;
    defaultProvider?: string;
  },
): { selection: T | { provider: string; model: string; source: 'config' } | undefined; decision: OverloadFailoverLaunchDecision } {
  const provider = selection?.provider ?? opts.defaultProvider ?? 'openai-codex';
  const decision = decideOverloadFailoverLaunch({
    codexExplicit: opts.codexExplicit,
    provider,
    ...(selection?.model !== undefined ? { model: selection.model } : {}),
    outcomes: opts.outcomes,
    grokAvailable: opts.grokAvailable,
  });
  if (!decision.switched || !decision.model) return { selection, decision };
  return {
    selection: { provider: decision.provider, model: decision.model, source: 'config' },
    decision,
  };
}
