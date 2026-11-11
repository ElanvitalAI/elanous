// ── LogRecord — MSS canonical log envelope (PLAN §8.1) ──
//
// Superset of the legacy `DebugEvent` shape — every legacy field is kept
// and the new MSS fields (trace_id / span_id / parent_span_id / elanous_id /
// source / level) layer on as optionals. `src/debug/log.ts` emits records
// that conform to this interface while keeping its public API
// (`debug.log(category, event, data?)`) byte-identical.

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'critical';
import type { Provenance } from '../../provenance/provenance.js';

export const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
  critical: 5,
};

export interface LogSource {
  file?: string;
  line?: number;
  fn?: string;
  /** SAM S0 seed — free-form platform label (e.g. `'darwin'`, `'linux'`,
   *  `'win32'`, `'ios'`, `'android'`, `'web'`). Populated by the debug
   *  tracer enrichment pass via `process.platform` when the caller omits
   *  it. Enables multi-platform client log disambiguation without a
   *  schema bump. */
  platform?: string;
}

export interface LogRecord {
  /** ISO-8601 timestamp (the legacy `DebugEvent.ts` field). */
  ts: string;
  /** Kebab-dotted namespace, e.g. `pfc.classify`. Automatically inferred
   *  from file path when the caller omits it — see §11.5.2. */
  category: string;
  /** Short human-readable one-liner. Same as legacy `DebugEvent.event`. */
  event: string;
  /** Optional structured payload. Same as legacy `DebugEvent.data`. */
  data?: unknown;
  /** Optional severity. Most debug.log sites are `trace`/`debug`; higher
   *  levels are set explicitly by critical-junction emitters. */
  level?: LogLevel;
  trace_id?: string;
  span_id?: string;
  parent_span_id?: string;
  elanous_id?: string;
  source?: LogSource;
  /** Origin contract; absent historical rows are unknown and never real. */
  provenance?: Provenance;
  pid?: number;
}

/** Serialize a LogRecord to one NDJSON line (no trailing newline). */
export function toJsonl(rec: LogRecord): string {
  return JSON.stringify(rec);
}

/** Parse one NDJSON line back into a LogRecord — returns null on malformed
 *  input rather than throwing so log-tailing UIs can skip corrupt lines. */
export function fromJsonl(line: string): LogRecord | null {
  if (!line || line.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(line);
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof parsed.ts !== 'string' ||
      typeof parsed.category !== 'string' ||
      typeof parsed.event !== 'string'
    ) {
      return null;
    }
    return parsed as LogRecord;
  } catch {
    return null;
  }
}
