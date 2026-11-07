// ── Log enrichment — attach MSS context fields to a raw log record ──
//
// PLAN §9.6.5 — `debug.log('msg', fields?)` signature is preserved. The
// actual integration into `src/debug/log.ts` lands in PR #4; this module
// is the pure helper that produces the enriched record so both the
// existing debug logger and any future sink can share one code path.
//
// DD-MSS-33 — every enriched field is optional when unavailable, so the
// helper never throws when called from a context without a live trace
// frame or a writable identity file.

import { getFlags } from './feature-flags.js';
import { getOrCreateElanousId } from './identity-store.js';
import { getParentSpanId, getSpanId, getTraceId } from './trace-context.js';
import { inferCategoryFromPath } from './category-infer.js';

export interface RawLogInput {
  /** Optional explicit category — overrides file-path inference. */
  category?: string;
  /** Short human-readable one-liner (mirrors existing `debug.log` event arg). */
  event: string;
  /** Optional structured payload (field set). */
  fields?: Record<string, unknown>;
  /** Call-site path — populated by the caller via
   *  `new Error().stack` parsing. Used for category inference and the
   *  `source.file` field. Optional because the pure helper should remain
   *  testable without a real stack. */
  filePath?: string;
  /** Optional call-site line number (from stack parsing). */
  line?: number;
  /** Optional function name (from stack parsing). */
  fnName?: string;
  /** Optional explicit timestamp (ms); otherwise `Date.now()`. */
  nowMs?: number;
}

export interface EnrichedLog {
  ts: string;
  category: string;
  event: string;
  fields?: Record<string, unknown>;
  trace_id?: string;
  span_id?: string;
  parent_span_id?: string;
  elanous_id?: string;
  source?: { file?: string; line?: number; fn?: string };
  pid: number;
}

/** Enrich a raw log input with trace/identity/source context. Pure — never
 *  throws; missing context simply yields an undefined field. */
export function enrichLogRecord(raw: RawLogInput): EnrichedLog {
  const flags = getFlags();
  const ts = new Date(raw.nowMs ?? Date.now()).toISOString();

  const category = raw.category
    ?? (raw.filePath ? inferCategoryFromPath(raw.filePath, raw.fnName) : 'unknown.anonymous');

  const out: EnrichedLog = {
    ts,
    category,
    event: raw.event,
    pid: process.pid,
  };
  if (raw.fields && Object.keys(raw.fields).length > 0) out.fields = raw.fields;

  if (!flags.enabled) {
    // MVS opt-out — callers still get a well-formed record but without
    // identity / trace enrichment, matching pre-MSS behaviour shape.
    return out;
  }

  const trace = getTraceId();
  if (trace) out.trace_id = trace;
  const span = getSpanId();
  if (span) out.span_id = span;
  const parent = getParentSpanId();
  if (parent) out.parent_span_id = parent;

  try {
    out.elanous_id = getOrCreateElanousId();
  } catch { /* identity write failed — leave elanous_id undefined */ }

  const source: { file?: string; line?: number; fn?: string } = {};
  if (raw.filePath) source.file = raw.filePath;
  if (raw.line !== undefined) source.line = raw.line;
  if (raw.fnName) source.fn = raw.fnName;
  if (source.file || source.line !== undefined || source.fn) out.source = source;

  return out;
}
