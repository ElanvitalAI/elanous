// kit/audit-ledger (PLATFORM-KITS-DUPLICATION-MAP-1127 §1-15 «감사 원장»): ten-plus `*-audit.jsonl` writers each did their
// own `mkdirSync ⊕ appendFileSync` — no fsync, no rotation, no schema tag, and a different failure contract per file.
// This is the one append-only JSONL writer. Paths and row fields stay with the caller; the kit owns how a line lands.
//
// 세 얼굴: 관측 = `elanous logs --category kit.audit-ledger` (rotated · write-failed) / 판단 근거 = one rule here:
// open(a) → write one whole line → fsync → close; rotate by size before the write (`<path>.1` … `<path>.<keep>`) /
// 수복 = the strict writer throws (fail-closed callers such as the els control door keep their «audit-failed» outcome);
// the safe writer logs and returns false so no dispatch path blocks on disk.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { debug } from '../../debug/log.js';

export interface AuditWriteOptions {
  /** Rotate when the file would grow past this many bytes (default 10 MB). 0 = never rotate. */
  readonly maxBytes?: number;
  /** Rotated generations kept (`<path>.1` newest … `<path>.<keep>` oldest; default 3). */
  readonly keep?: number;
  /** File mode for a newly created ledger (e.g. 0o600 for els audit files). */
  readonly mode?: number;
}

export const AUDIT_MAX_BYTES = 10 * 1024 * 1024;
export const AUDIT_KEEP = 3;
const TAIL_BYTES = 2 * 1024 * 1024;

function rotate(path: string, keep: number): void {
  if (keep <= 0) { rmSync(path, { force: true }); return; }
  rmSync(`${path}.${keep}`, { force: true });
  for (let i = keep - 1; i >= 1; i--) if (existsSync(`${path}.${i}`)) renameSync(`${path}.${i}`, `${path}.${i + 1}`);
  renameSync(path, `${path}.1`);
  try { debug.log('kit.audit-ledger', 'rotated', { path, keep }); } catch { /* observe only */ }
}

/** Strict: append one pre-serialized line (a trailing newline is added when missing). Throws on any fs failure. */
export function appendAuditLine(path: string, line: string, opts: AuditWriteOptions = {}): void {
  const text = line.endsWith('\n') ? line : `${line}\n`;
  const maxBytes = opts.maxBytes ?? AUDIT_MAX_BYTES;
  mkdirSync(dirname(path), { recursive: true });
  if (maxBytes > 0) {
    let size = 0;
    try { size = statSync(path).size; } catch { /* absent */ }
    if (size > 0 && size + Buffer.byteLength(text) > maxBytes) rotate(path, opts.keep ?? AUDIT_KEEP);
  }
  const fd = openSync(path, 'a', opts.mode ?? 0o644);
  try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
}

/** The row as written: the schema tag first, then `at` unless the row already carries its own `at`/`ts`. */
export function auditRow(schema: string, row: Record<string, unknown>, now: Date = new Date()): Record<string, unknown> {
  const stamped = 'at' in row || 'ts' in row ? {} : { at: now.toISOString() };
  return { schema, ...stamped, ...row };
}

/** Strict: append `{schema, at, ...row}`. Throws on failure. */
export function appendAudit(path: string, schema: string, row: Record<string, unknown>, opts: AuditWriteOptions = {}): void {
  appendAuditLine(path, JSON.stringify(auditRow(schema, row)), opts);
}

/** Fail-soft line writer: logs `kit.audit-ledger write-failed` and returns false instead of throwing. */
export function appendAuditLineSafe(path: string, line: string, opts: AuditWriteOptions = {}): boolean {
  try { appendAuditLine(path, line, opts); return true; } catch (error) {
    try { debug.log('kit.audit-ledger', 'write-failed', { path, error: error instanceof Error ? error.message : String(error) }); } catch { /* observe only */ }
    return false;
  }
}

/** Fail-soft row writer — for audit trails that must never block the caller. */
export function appendAuditSafe(path: string, schema: string, row: Record<string, unknown>, opts: AuditWriteOptions = {}): boolean {
  let line: string;
  try { line = JSON.stringify(auditRow(schema, row)); } catch (error) {
    try { debug.log('kit.audit-ledger', 'write-failed', { path, error: error instanceof Error ? error.message : String(error) }); } catch { /* observe only */ }
    return false;
  }
  return appendAuditLineSafe(path, line, opts);
}

/** Read the last `limit` well-formed rows from the live file's tail (2 MB). Malformed or half-written lines are skipped. */
export function readAuditTail<T = Record<string, unknown>>(path: string, limit = 200): T[] {
  let size: number;
  try { size = statSync(path).size; } catch { return []; }
  const start = Math.max(0, size - TAIL_BYTES);
  const fd = openSync(path, 'r');
  let text: string;
  try { const buf = Buffer.alloc(size - start); readSync(fd, buf, 0, buf.length, start); text = buf.toString('utf8'); } finally { closeSync(fd); }
  const lines = text.split('\n');
  if (start > 0) lines.shift();
  const out: T[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try { const v = JSON.parse(line) as unknown; if (v && typeof v === 'object' && !Array.isArray(v)) out.push(v as T); } catch { /* skip */ }
  }
  return limit > 0 ? out.slice(-limit) : out;
}
