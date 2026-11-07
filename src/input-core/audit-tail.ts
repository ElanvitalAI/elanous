// Audit tail helper — R4.
//
// Reads recent NDJSON lines from the control audit log
// (~/.monad-agent/audit/control-YYYY-MM-DD.ndjson) and filters them.
// Today + yesterday files are scanned to cover wraparound near
// midnight without blowing out the read budget.
//
// Consumers: `/audit input` slash (dashboard). Other call sites can
// pass a different category predicate when they need it.

import { readFileSync, existsSync } from 'node:fs';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { join } from 'node:path';
import { formatClock } from '../time/clock.js';

export interface AuditEntry {
  ts: string;                // ISO-8601 UTC
  action: string;            // e.g. 'input_set_mode'
  subject?: string;
  ok: boolean;
  detail?: Record<string, unknown>;
}

export interface AuditTailOpts {
  /** Filter — only entries whose `action` passes. Default: accept all. */
  match?: (entry: AuditEntry) => boolean;
  /** How many entries to keep (newest last). Default 20. */
  tail?: number;
  /** Look back N ms from now. Default: no time filter (whole files). */
  sinceMs?: number;
  /** Root override for tests. */
  root?: string;
  /** Clock override for tests. */
  now?: () => number;
}

export interface AuditTailResult {
  entries: AuditEntry[];           // oldest → newest within the tail window
  filesScanned: string[];          // absolute paths (for debugging / "no file" messages)
  truncated: boolean;              // true when more entries were available than `tail`
}

function dateKey(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

// FU2 Tier 3 (PLAN-config-unification-elanous-root-2026-05-10):
//   reads from ~/.elanous/audit/ (canonical · 2026-05-10). Migration
//   itself is fired by the writers (control-audit-log · guardian ·
//   shell-primitive) so this read-only consumer just needs the new
//   path.
function defaultRoot(): string {
  return join(elanousStateRoot(), 'audit');
}

/** Parse a single NDJSON line; returns null on malformed input or
 *  when the decoded object doesn't have the required fields. Callers
 *  silently skip nulls. */
function parseLine(line: string): AuditEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const obj = JSON.parse(trimmed);
    if (typeof obj !== 'object' || obj === null) return null;
    if (typeof obj.ts !== 'string' || typeof obj.action !== 'string'
        || typeof obj.ok !== 'boolean') return null;
    return obj as AuditEntry;
  } catch {
    return null;
  }
}

export function readAuditTail(opts: AuditTailOpts = {}): AuditTailResult {
  const tail = opts.tail ?? 20;
  const match = opts.match ?? (() => true);
  const root = opts.root ?? defaultRoot();
  const nowFn = opts.now ?? Date.now;
  const sinceMs = opts.sinceMs;

  const nowTs = nowFn();
  const today = new Date(nowTs);
  const yesterday = new Date(nowTs - 24 * 60 * 60 * 1000);
  const paths = [
    join(root, `control-${dateKey(yesterday)}.ndjson`),
    join(root, `control-${dateKey(today)}.ndjson`),
  ];
  const filesScanned: string[] = [];
  const collected: AuditEntry[] = [];

  for (const p of paths) {
    if (!existsSync(p)) continue;
    filesScanned.push(p);
    let content: string;
    try { content = readFileSync(p, 'utf8'); }
    catch { continue; }
    for (const line of content.split('\n')) {
      const ev = parseLine(line);
      if (!ev) continue;
      if (sinceMs !== undefined) {
        const t = Date.parse(ev.ts);
        if (Number.isFinite(t) && nowTs - t > sinceMs) continue;
      }
      if (!match(ev)) continue;
      collected.push(ev);
    }
  }

  // Sort by ts ASC (oldest first) and keep the tail.
  collected.sort((a, b) => a.ts.localeCompare(b.ts));
  const truncated = collected.length > tail;
  const entries = truncated ? collected.slice(-tail) : collected;
  return { entries, filesScanned, truncated };
}

/** Convenience filter — entries that concern the input policy surface
 *  (SetInputMode, SetInputBinding, clear-binding, etc.). Action name
 *  prefix is the stable contract. */
export function isInputAuditEntry(entry: AuditEntry): boolean {
  return entry.action.startsWith('input_');
}

/** One-line renderer — ISO-time in HH:MM:SS, OK/FAIL tag, action,
 *  subject, compact detail. Returns plain string; caller applies
 *  color / chalk wrapping. */
export function formatAuditEntry(entry: AuditEntry): string {
  const timePart = formatClock(entry.ts);               // 사용자 시간대 HH:MM:SS
  const okPart = entry.ok ? 'ok ' : 'FAIL';
  const subj = entry.subject ? ` ${entry.subject}` : '';
  const detail = entry.detail && Object.keys(entry.detail).length > 0
    ? ` ${JSON.stringify(entry.detail)}`
    : '';
  return `${timePart} [${okPart}] ${entry.action}${subj}${detail}`;
}

/** Parse human-ish duration strings (e.g. "30m", "2h", "15s") to ms.
 *  Used by `/audit --since <duration>`. Returns null on malformed
 *  input so the slash handler can report a helpful error. */
export function parseDuration(s: string): number | null {
  const m = s.match(/^(\d+)\s*(ms|s|m|h|d)?$/i);
  if (!m) return null;
  const n = Number.parseInt(m[1]!, 10);
  if (!Number.isFinite(n)) return null;
  const unit = (m[2] ?? 's').toLowerCase();
  switch (unit) {
    case 'ms': return n;
    case 's':  return n * 1000;
    case 'm':  return n * 60 * 1000;
    case 'h':  return n * 60 * 60 * 1000;
    case 'd':  return n * 24 * 60 * 60 * 1000;
    default:   return null;
  }
}
