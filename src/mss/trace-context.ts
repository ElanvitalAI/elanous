// ── Trace context — AsyncLocalStorage-based trace_id/span_id propagation ──
//
// DD-MSS-26 — `trace_id` is the turn-level root span; every child async
// action (LLM call, tool invocation, modal push) inherits it automatically.
// PLAN §9.6.5 — this module provides the AsyncLocalStorage frames that
// `log-enrich.ts` reads when stamping each LogRecord.
//
// A child span is emitted per `withSpan()` block so callers can still
// delineate work inside a turn without managing IDs manually.

import { AsyncLocalStorage } from 'node:async_hooks';
import { newUlid } from './ulid.js';

export interface TraceContext {
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
}

const storage = new AsyncLocalStorage<TraceContext>();

/** Run `fn` with an explicit trace context. Callers already holding IDs
 *  (e.g. ACP session, distributed incoming request) use this to bridge
 *  external trace_id into the local frame. */
export function withTraceContext<T>(ctx: TraceContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** Convenience — begin a fresh turn. Generates trace_id AND root span_id
 *  so the caller doesn't have to know the envelope shape. Used by the
 *  PFC turn dispatcher in future phases (M1.1+). */
export function startTurnTrace<T>(fn: () => T): T {
  const ctx: TraceContext = {
    trace_id: newUlid(),
    span_id: newUlid(),
  };
  return storage.run(ctx, fn);
}

/** Run `fn` inside a child span — parent_span_id is inherited so the
 *  caller's event graph links back to the turn root. If no parent
 *  context exists (called outside any turn) a fresh trace is started
 *  so downstream enrichment still has something to stamp. */
export function withSpan<T>(fn: () => T): T {
  const parent = storage.getStore();
  if (!parent) {
    return startTurnTrace(fn);
  }
  const child: TraceContext = {
    trace_id: parent.trace_id,
    span_id: newUlid(),
    parent_span_id: parent.span_id,
  };
  return storage.run(child, fn);
}

export function getTraceId(): string | undefined {
  return storage.getStore()?.trace_id;
}

export function getSpanId(): string | undefined {
  return storage.getStore()?.span_id;
}

export function getParentSpanId(): string | undefined {
  return storage.getStore()?.parent_span_id;
}

/** Full snapshot of the current trace frame — undefined when called
 *  outside any `withTraceContext` / `withSpan` scope. */
export function getTraceContext(): TraceContext | undefined {
  return storage.getStore();
}

/** Mint a new span id without entering a scope — useful when a caller
 *  wants to pass an id into a remote RPC that will itself open a span
 *  on its side. Does not mutate storage. */
export function newSpanId(): string {
  return newUlid();
}
