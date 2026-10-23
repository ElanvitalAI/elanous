// TUI-LOG-SESSION-TAG (0.2.36 · 10-23) — tell TUIs apart in one logs.db.
//
// Several TUIs (classic `elanous` / `--legacy` and `--tui next`) on one host write to the same logs.db
// with surface `tui`. Their rows had no pid and usually no session_id (the dashboard does not set the
// ambient session), so the 10-23 n8n SIGTTIN incident could not tell which TUI's `tui.event-loop stall`
// was which. This wraps the TUI's logs.db sink and stamps every plain-object payload with:
//   tuiPid      — the TUI process id
//   tuiName     — the `--name` launch alias (when given)
//   tuiSession  — the chat session the TUI currently owns (getTuiOwnedSession, when known)
// Caller-supplied fields win; primitive / non-plain payloads are left untouched; an absent payload becomes
// the tag object. No schema change — the tag rides in the existing `data` column.
//
// Query: `elanous logs --surface tui --grep '"tuiName":"n8n"'` · `--grep '"tuiPid":20960'`
//        or `--json | jq 'select((.data|fromjson? // {}).tuiName == "n8n")'`.

import type { LogSink } from '../mss/logging/sink.js';
import type { LogRecord } from '../mss/logging/record.js';

export interface TuiLogTag {
  pid: number;
  name?: string;
  /** Current owned chat session id, or null. Called per record — keep it cheap. */
  session?: () => string | null | undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const p = Object.getPrototypeOf(value);
  return p === Object.prototype || p === null;
}

/** Pure — returns the record with the tag applied (a new object when changed). */
export function tagTuiRecord(rec: LogRecord, tag: TuiLogTag): LogRecord {
  let session: string | null | undefined;
  try { session = tag.session?.(); } catch { session = undefined; }
  const add: Record<string, unknown> = { tuiPid: tag.pid };
  const name = tag.name?.trim();
  if (name) add.tuiName = name;
  if (session) add.tuiSession = session;
  if (rec.data === undefined) return { ...rec, data: add };
  if (!isPlainObject(rec.data)) return rec;
  const data = rec.data;
  const missing = Object.entries(add).filter(([k]) => !Object.hasOwn(data, k));
  if (missing.length === 0) return rec;
  return { ...rec, data: { ...data, ...Object.fromEntries(missing) } };
}

// Process-wide tag state — the TUI's self-report fills it (`--name` at launch, the owned session on every
// claim) so the sink wrapper needs no import of the TUI modules (no cycle · no hub edit).
let processName: string | undefined;
let processSession: string | null = null;
export function setTuiLogName(name: string | undefined): void { processName = name?.trim() || undefined; }
export function setTuiLogSession(id: string | null): void { processSession = id || null; }
/** The tag for this process: pid ⊕ the state above. */
export function processTuiLogTag(): TuiLogTag {
  return { pid: process.pid, get name() { return processName; }, session: () => processSession };
}

/** Wraps a sink so every record it receives is tagged. */
export function withTuiLogTag(inner: LogSink, tag: TuiLogTag): LogSink {
  return {
    name: inner.name,
    emit(rec: LogRecord): void { inner.emit(tagTuiRecord(rec, tag)); },
    ...(inner.flush ? { flush: () => inner.flush?.() } : {}),
    ...(inner.clear ? { clear: () => inner.clear?.() } : {}),
  };
}
