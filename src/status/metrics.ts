// ── Session status metrics ──
//
// Cumulative tracker for the bottom secondary-status row
// (CTX bar · 💰 · 🚀 · ⏱). Claude-code-style: one module-level
// singleton that every LLM call contributes to (runTurn, dashboard
// streaming, skill-runner). Snapshots drive the status bar row.
//
// Explicitly kept SIMPLE:
//   - No persistence across process restarts (session-local only).
//   - Tokens are estimated via chars/4 when the provider doesn't
//     expose usage (most streaming providers don't send counts in
//     the delta stream without stream_options.include_usage).
//   - Cost computed on finalized turn only; partial updates during
//     streaming just show the running token count.
//   - Context budget is shared with session-chat.ts DEFAULT_TOKEN_BUDGET.

import { costForUsageDetailed, type TokenUsage } from '../models/costs.js';
import { resolveModelContextWindow } from '../models/context-window.js';
import { DEFAULT_TOKEN_BUDGET, estimateMessagesTokens, estimateTokens } from '../tokens.js';

export interface SessionMetrics {
  /** Cumulative input tokens sent this session. */
  totalInputTokens: number;
  /** Cumulative output tokens produced this session. */
  totalOutputTokens: number;
  /** Cumulative USD cost — rough, uses per-model pricing table. */
  totalCostUsd: number;
  /** 단가를 몰라 합계에 «안 넣은» 턴 수(BACKLOG C9) — 0 이 아니면 합계는 하한이다. */
  unpricedTurns: number;
  /** Wallclock seconds across all turns this session. */
  totalSeconds: number;
  /** How many turns have been recorded. */
  turnCount: number;
  /** When the session started (monotonic-ish; unix ms). */
  sessionStartedAt: number;
  /** Last turn's ratio used/max for the CTX bar. */
  lastContextUsed: number;
  lastContextMax: number;
  /** Last turn's tokens-per-second (output tok / wall sec). */
  lastTokensPerSec: number | null;
  /** Last turn's model id — surfaced in the pill if different from
   *  the config's active model. */
  lastModel: string;
}

function freshMetrics(): SessionMetrics {
  return {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostUsd: 0,
    unpricedTurns: 0,
    totalSeconds: 0,
    turnCount: 0,
    sessionStartedAt: Date.now(),
    lastContextUsed: 0,
    lastContextMax: DEFAULT_TOKEN_BUDGET,
    lastTokensPerSec: null,
    lastModel: '',
  };
}

let singleton: SessionMetrics = freshMetrics();

export function getSessionMetrics(): Readonly<SessionMetrics> { return singleton; }

export function resetSessionMetrics(): void { singleton = freshMetrics(); }

export interface RecordTurnInput {
  model: string;
  /** Provider-reported usage when available; falls back to chars/4
   *  estimate via `estimatedPromptText` / `estimatedOutputText`. */
  usage?: Partial<TokenUsage>;
  /** Text that was sent to the model (used when usage.inputTokens
   *  isn't available). */
  estimatedPromptText?: string;
  /** Text produced by the model. */
  estimatedOutputText?: string;
  /** Wall-clock seconds the turn took. */
  seconds: number;
  /** Optional override for the context bar's `max`. Defaults to the
   *  session-chat DEFAULT_TOKEN_BUDGET. */
  contextMax?: number;
}

/** Record a completed turn's tokens + cost + time. Idempotent:
 *  callers can safely call once at end-of-turn from runTurn or
 *  dashboard. */
export function recordTurn(input: RecordTurnInput): SessionMetrics {
  const inputTokens = input.usage?.inputTokens
    ?? estimateTokens(input.estimatedPromptText ?? '');
  const outputTokens = input.usage?.outputTokens
    ?? estimateTokens(input.estimatedOutputText ?? '');
  const cacheReadTokens = input.usage?.cacheReadTokens ?? 0;
  const cacheWriteTokens = input.usage?.cacheWriteTokens ?? 0;

  const priced = costForUsageDetailed(input.model, {
    inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
  });
  const turnCost = priced.usd;
  if (!priced.known) singleton.unpricedTurns += 1;

  singleton.totalInputTokens += inputTokens;
  singleton.totalOutputTokens += outputTokens;
  singleton.totalCostUsd += turnCost;
  singleton.totalSeconds += input.seconds;
  singleton.turnCount += 1;
  singleton.lastModel = input.model;

  const ctxMax = input.contextMax
    ?? resolveModelContextWindow(input.model)
    ?? DEFAULT_TOKEN_BUDGET;
  singleton.lastContextUsed = inputTokens + outputTokens;
  singleton.lastContextMax = ctxMax;

  singleton.lastTokensPerSec = input.seconds > 0
    ? outputTokens / input.seconds
    : null;

  return singleton;
}

/**
 * A conversation was just restored (`/session load` · `--resume`): the next turn will send all of it,
 * so the ctx readout shows that size now instead of 0 until the first turn reports real usage
 * (TUI-RESUME-PICKER ④). The first `recordTurn` replaces it with the provider's number.
 */
export function noteRestoredContext(history: readonly { role: string; content: unknown }[]): number {
  const used = estimateMessagesTokens(history.map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '') })));
  singleton.lastContextUsed = used;
  return used;
}

/** Elapsed time since session start, in seconds. Updated on every
 *  call (doesn't depend on recordTurn firing). */
export function sessionElapsedSec(): number {
  return Math.max(0, (Date.now() - singleton.sessionStartedAt) / 1000);
}
