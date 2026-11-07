import type { Database } from 'bun:sqlite';
import { debug, redactSecretText } from '../debug/log.js';
import { openSurfaceEventsDb, recordEvent } from '../domains/surface-events.js';

export type ExternalEventOrigin = 'claude-code' | 'codex-agent-mission' | 'harness-child' | 'release-graph';
export type ContextHookKind = 'claimed' | 'done' | 'asked' | 'guide-changed';
export type ExternalEventKind = ContextHookKind | 'started' | 'finished' | 'exit';
export const CONTEXT_SUMMARY_MAX = 120;
export const CONTEXT_SOURCE_MAX = 512;

export interface ExternalEventInput {
  origin: ExternalEventOrigin;
  kind: ExternalEventKind;
  summary: string;
  source: string;
  /** Durable subscriber receipt key; present only for idempotent release-graph delivery. */
  delivery?: { eventId: string; subscriberId: string };
  at?: string;
}

/** Only a single, bounded, redacted summary and a locator enter the journal; no prompt or transcript. */
export function recordExternalEvent(input: ExternalEventInput, deps: { db?: Database } = {}): string {
  if (!['claude-code', 'codex-agent-mission', 'harness-child', 'release-graph'].includes(input.origin)) throw new Error('invalid context origin');
  if (input.origin === 'claude-code'
    ? !['claimed', 'done', 'asked', 'guide-changed'].includes(input.kind)
    : !['started', 'finished', 'exit'].includes(input.kind)) throw new Error('invalid context kind');
  if (input.origin === 'release-graph' && (!input.delivery || !input.delivery.eventId.trim() || !input.delivery.subscriberId.trim()))
    throw new Error('release graph context delivery requires eventId and subscriberId');
  if (input.delivery && input.origin !== 'release-graph') throw new Error('delivery receipts are only valid for release-graph events');
  const summary = redactSecretText(input.summary.split(/\r?\n/, 1)[0] ?? '').trim().slice(0, CONTEXT_SUMMARY_MAX);
  const source = redactSecretText(input.source.split(/\r?\n/, 1)[0] ?? '').trim();
  if (!summary) throw new Error('context summary must be one nonempty line');

  if (!/^(?:https?:\/\/|elanous:\/\/)[^\s]+$/.test(source) || source.length > CONTEXT_SOURCE_MAX) {
    throw new Error('context source must be a link (http(s) or elanous://), at most 512 characters');
  }
  const db = deps.db ?? openSurfaceEventsDb();
  try {
    const refs = JSON.stringify({ seat: input.origin, recipients: [], all: false, kind: input.kind,
      slot: null, deadline: null, url: source, origin: input.origin, source, ...(input.delivery ?? {}) });
    return db.transaction(() => {
      if (input.delivery) {
        const prior = db.prepare(`SELECT id FROM events WHERE surface='context:external'
          AND json_extract(refs,'$.eventId')=? AND json_extract(refs,'$.subscriberId')=? LIMIT 1`)
          .get(input.delivery.eventId, input.delivery.subscriberId) as { id: string } | null;
        if (prior) return prior.id;
      }
      return recordEvent(db, {
        surface: 'context:external', direction: 'outbound', domain: 'elanous', category: 'coordination',
        kind: input.kind, text: summary, summary, refs,
        ...(input.at ? { ts: input.at } : {}),
      });
    }).immediate();
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
