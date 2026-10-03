import type { Database } from 'bun:sqlite';
import { debug, redactSecretText } from '../debug/log.js';
import { openSurfaceEventsDb, recordEvent } from '../domains/surface-events.js';

export type ExternalEventOrigin = 'claude-code' | 'codex-agent-mission' | 'harness-child';
export type ContextHookKind = 'claimed' | 'done' | 'asked' | 'guide-changed';
export type ExternalEventKind = ContextHookKind | 'started' | 'finished';
export const CONTEXT_SUMMARY_MAX = 120;
export const CONTEXT_SOURCE_MAX = 512;

export interface ExternalEventInput {
  origin: ExternalEventOrigin;
  kind: ExternalEventKind;
  summary: string;
  source: string;
  at?: string;
}

/** Only a single, bounded, redacted summary and a locator enter the journal; no prompt or transcript. */
export function recordExternalEvent(input: ExternalEventInput, deps: { db?: Database } = {}): string {
  if (!['claude-code', 'codex-agent-mission', 'harness-child'].includes(input.origin)) throw new Error('invalid context origin');
  if (input.origin === 'claude-code'
    ? !['claimed', 'done', 'asked', 'guide-changed'].includes(input.kind)
    : !['started', 'finished'].includes(input.kind)) throw new Error('invalid context kind');
  const summary = redactSecretText(input.summary.split(/\r?\n/, 1)[0] ?? '').trim().slice(0, CONTEXT_SUMMARY_MAX);
  const source = redactSecretText(input.source.split(/\r?\n/, 1)[0] ?? '').trim();
  if (!summary) throw new Error('context summary must be one nonempty line');

  if (!/^(?:https?:\/\/|elanous:\/\/)[^\s]+$/.test(source) || source.length > CONTEXT_SOURCE_MAX) {
    throw new Error('context source must be a link (http(s) or elanous://), at most 512 characters');
  }
  const db = deps.db ?? openSurfaceEventsDb();
  try {
    return recordEvent(db, {
      surface: 'context:external', direction: 'outbound', domain: 'elanous', category: 'coordination',
      kind: input.kind, text: summary, summary,
      refs: JSON.stringify({ seat: input.origin, recipients: [], all: false, kind: input.kind,
        slot: null, deadline: null, url: source, origin: input.origin, source }),
      ...(input.at ? { ts: input.at } : {}),
    });
  } finally { if (!deps.db) db.close(); }
}

/** Instrumentation never changes an agent's result. Failures remain visible without logging untrusted payloads. */
export function observeExternalEvent(input: ExternalEventInput, record: typeof recordExternalEvent = recordExternalEvent): void {
  try { record(input); }
  catch (error) {
    try { debug.log('context.external', 'record-failed', {
      origin: input.origin, kind: input.kind, reason: error instanceof Error ? error.message : String(error),
    }, { level: 'warn' }); } catch { /* A broken logger cannot change an agent's result. */ }
  }
}
