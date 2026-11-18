/**
 * ELN-TURN-STALL-WATCHDOG — «Responding» for an hour with 1.4k output (JUD-B 11-18 · qwen3.8-max): the stream keeps
 * delivering events (reasoning, usage, keepalive), so the stream idle watchdog — which only sees silence — never fires,
 * yet nothing a person or a tool can use comes out.
 *
 * Progress, precisely: an output event of the model —
 *   - a `text` event whose delta has ≥ 1 character (output tokens), or
 *   - a `tool_call` event (the model asked for a tool), or
 *   - an `image` event.
 * Reasoning deltas, reasoning summaries, usage, finish/turn_end/text_phase and any other bookkeeping event are NOT
 * progress. Tool execution is never measured at all: the clock exists only while a provider stream attempt is open and
 * restarts at every attempt, and the tool loop runs tools between attempts — a long Bash or Agent call cannot trip it.
 */

/** Default M. Justification (24 h of `llm.response.complete «stream done»`, 20 000 most recent streams, 11-18):
 *  the longest completed stream was 336 s, and the longest with no text before its single tool call was 302 s —
 *  reasoning-only stretches of five minutes are legitimate. 10 min is twice that worst case, and still catches the
 *  1 h JUD-B turn within its first sixth. */
export const TURN_NO_PROGRESS_MS = 10 * 60_000;

/** The watchdog's own abort reason. `code` makes the shared fallback classifier treat it like a stalled socket
 *  (network-transient → the next provider in the chain), never like a request the user got wrong. */
export class StreamNoProgressError extends Error {
  readonly code = 'ETIMEDOUT';
  constructor(readonly limitMs: number, readonly quietMs: number) {
    super(`stream no progress: no output for ${quietMs}ms (limit ${limitMs}ms)`);
    this.name = 'StreamNoProgressError';
  }
}

export type TurnNoProgressSource = 'call' | 'config' | 'default';

/** Call option first, then `llm.turnNoProgressMs` from config, then {@link TURN_NO_PROGRESS_MS}. Non-positive = unset. */
export function resolveTurnNoProgressMs(callMs: number | undefined, configMs: number | undefined): { ms: number; source: TurnNoProgressSource } {
  if (callMs !== undefined && Number.isFinite(callMs) && callMs > 0) return { ms: callMs, source: 'call' };
  if (configMs !== undefined && Number.isFinite(configMs) && configMs > 0) return { ms: configMs, source: 'config' };
  return { ms: TURN_NO_PROGRESS_MS, source: 'default' };
}

/** The progress definition above, as a predicate over one stream event. */
export function isTurnProgressEvent(ev: { readonly type: string; readonly delta?: unknown }): boolean {
  if (ev.type === 'text') return typeof ev.delta === 'string' && ev.delta.length > 0;
  return ev.type === 'tool_call' || ev.type === 'image';
}

/** What the tool loop reports when the watchdog fires (before it retries or gives up). */
export interface TurnNoProgressFire {
  readonly provider: string;
  readonly model: string;
  readonly quietMs: number;
  readonly limitMs: number;
}
