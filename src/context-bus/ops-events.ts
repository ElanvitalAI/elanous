import type { Database } from 'bun:sqlite';
import { debug, redactSecretText } from '../debug/log.js';
import { openSurfaceEventsDb, recordEvent, surfaceEventsDbPath } from '../domains/surface-events.js';

export const OPS_EVENT_KINDS = [
  'land.start', 'land.refused', 'land.merged',
  'review.verdict',
  'gate.rc',
  'cell.opened', 'cell.hold',
  'config.set',
] as const;
export type OpsEventKind = typeof OPS_EVENT_KINDS[number];

export interface OpsEventInput {
  kind: OpsEventKind;
  /** One nonempty line describing the ops fact; multi-line input keeps only the first line. */
  text: string;
  /** Optional locator — PR number, checklist cell id, config key, release version. */
  ref?: string;
  /** Optional ISO timestamp; unparseable values are dropped. */
  at?: string;
}

export interface OpsEventDeps {
  db?: Database;
  /** Injection seam for tests; defaults to the surface-events recordEvent. */
  record?: typeof recordEvent;
}

/** Persist a one-line harness ops fact (land flow · review verdict · release gate ·
 *  checklist cell · config set) into the existing surface_events.db journal via
 *  recordEvent (src/domains/surface-events.ts) so pr-cli / release-loop operations
 *  become recallable observations instead of vanishing side effects.
 *  Fail-soft contract: any write-path failure — db open error, recordEvent throw,
 *  schema mismatch — is caught, logged to debug, and swallowed. This writer never
 *  throws and never rejects; callers fire it as a side call without touching their
 *  own control flow. Malformed input (non-object, unknown kind, empty text) is a
 *  silent no-op. Returns the recorded event id, or null when nothing was recorded. */
export function emitOpsEvent(input: OpsEventInput, deps: OpsEventDeps = {}): string | null {
  if (!input || typeof input !== 'object') return null;
  let db: Database | undefined = deps.db;
  let ownDb = false;
  try {
    if (!(OPS_EVENT_KINDS as readonly string[]).includes(input.kind)) return null;
    const oneLine = (value: unknown): string =>
      redactSecretText(String(value ?? '').split(/\r?\n/, 1)[0] ?? '').trim();
    const text = oneLine(input.text);
    if (!text) return null;
    const ref = oneLine(input.ref) || null;
    const at = typeof input.at === 'string' && !Number.isNaN(Date.parse(input.at)) ? input.at : undefined;
    if (!db) {
      // Test runners must never fall through to the user's production memory DB
      // (same guard as recordInboundTurn in domains/surface-events.ts).
      const testRunner = process.env.NODE_ENV === 'test' || process.env.BUN_TEST !== undefined;
      db = openSurfaceEventsDb(testRunner
        ? (process.env.ELANOUS_STATE_DIR?.trim() ? surfaceEventsDbPath() : ':memory:')
        : surfaceEventsDbPath());
      ownDb = true;
    }
    const record = deps.record ?? recordEvent;
    return record(db, {
      surface: 'ops', direction: 'outbound', domain: 'elanous', category: 'ops',
      kind: input.kind, text, summary: text.slice(0, 120),
      refs: JSON.stringify({ kind: input.kind, ref, url: null }),
      ...(at ? { ts: at } : {}),
    });
  } catch (error) {
    try { debug.log('ops.event', 'record-failed', {
      kind: input.kind, reason: error instanceof Error ? error.message : String(error),
    }, { level: 'warn' }); } catch { /* A broken logger cannot change the caller's result. */ }
    return null;
  } finally {
    if (ownDb && db) { try { db.close(); } catch { /* close failure is not the caller's problem */ } }
  }
}
