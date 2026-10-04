import type { Database } from 'bun:sqlite';
import { redactSecretText } from '../debug/log.js';
import { openSurfaceEventsDb, recordEvent } from '../domains/surface-events.js';

export const SESSION_EVENT_KINDS = ['task-claimed', 'task-done', 'asked', 'guidance-changed'] as const;
export type SessionEventKind = typeof SESSION_EVENT_KINDS[number];

export interface SessionEventInput {
  kind: SessionEventKind;
  seat: string;
  text: string;
  ref?: string;
  at?: string;
}

/** Publish a one-line external-agent session signal to the existing context journal. */
export function emitSessionEvent(input: SessionEventInput, deps: { db?: Database } = {}): string {
  if (!SESSION_EVENT_KINDS.includes(input.kind)) throw new Error('unknown context session kind');
  if (!['OP', 'TC', 'MK', 'UX'].includes(input.seat)) throw new Error('context session seat must be OP|TC|MK|UX');
  if (/\r|\n/.test(input.text) || !input.text.trim()) throw new Error('context session text must be one nonempty line');
  if (input.ref !== undefined && (/\r|\n/.test(input.ref) || !input.ref.trim())) throw new Error('context session ref must be one nonempty line');
  const summary = redactSecretText(input.text).trim().slice(0, 120);
  const ref = input.ref ?? null;
  const db = deps.db ?? openSurfaceEventsDb();
  try {
    return recordEvent(db, {
      surface: 'context:session', direction: 'outbound', domain: 'elanous', category: 'coordination',
      kind: input.kind, text: input.text, summary,
      refs: JSON.stringify({ seat: input.seat, recipients: [], all: false, kind: input.kind,
        slot: null, deadline: null, url: null, ref,
        ...(ref ? { source: `elanous://context/ref/${encodeURIComponent(ref)}` } : {}) }),
      ...(input.at ? { ts: input.at } : {}),
    });
  } finally { if (!deps.db) db.close(); }
}
