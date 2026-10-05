import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { dirname, join } from 'node:path';

export type SeatRequestStatus = 'pending' | 'queued' | 'rejected' | 'done';
export type SeatRequestRow = {
  key: string;
  seat: string;
  status: SeatRequestStatus;
  text: string;
  queuedAt: string;
  reason?: string;
  closedAt?: string;
  [field: string]: unknown;
};

export type SeatRequestFilters = { seat?: string; status?: SeatRequestStatus };
export type CloseSeatRequestsOptions = {
  reason: string;
  status?: 'rejected' | 'done';
  /** Minimum age in milliseconds, measured from queuedAt; only strictly older requests qualify. */
  olderThan?: number;
  now?: Date;
  dryRun?: boolean;
};

const ledgerPath = (root: string): string => join(root, 'seat-requests', 'requests.jsonl');

/** SQLite releases its transaction lock on process death, including SIGKILL. */
export function withSeatRequestLedgerLock<T>(path: string, work: () => T): T {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(`${path}.lock.sqlite`);
  try {
    db.exec('PRAGMA busy_timeout = 10000');
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } finally { db.close(); }
}

/** Called under the journal transaction lock; never expose a partial JSON line. */
export function appendSeatRequestRows<T>(path: string, rows: readonly T[],
  write: (fd: number, data: Buffer, offset: number, length: number) => number = writeSync): void {
  if (!rows.length) return;
  mkdirSync(dirname(path), { recursive: true });
  const prior = existsSync(path) ? readFileSync(path, 'utf8') : '';
  if (prior && !prior.endsWith('\n')) throw new Error('invalid seat request journal terminator');
  const data = Buffer.from(prior + rows.map((row) => `${JSON.stringify(row)}\n`).join(''));
  const temp = `${path}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temp, 'wx', 0o600);
    let offset = 0;
    while (offset < data.length) {
      const count = write(fd, data, offset, data.length - offset);
      if (count <= 0) throw new Error('seat request journal write stalled');
      offset += count;
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, path);
    const directory = openSync(dirname(path), 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temp); } catch { /* temp was not created or already renamed */ }
    throw error;
  }
}

function latestRows(text: string): Map<string, SeatRequestRow> {
  const latest = new Map<string, SeatRequestRow>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const row: unknown = JSON.parse(line);
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('invalid seat request row');
    const request = row as Record<string, unknown>;
    if (typeof request.key !== 'string' || !request.key || typeof request.seat !== 'string' || !request.seat
      || !['pending', 'queued', 'rejected', 'done'].includes(String(request.status))
      || typeof request.text !== 'string' || typeof request.queuedAt !== 'string') {
      throw new Error('invalid seat request row');
    }
    latest.set(request.key, request as SeatRequestRow);
  }
  return latest;
}

/** Filters apply to the latest row, never to a historical row superseded by a closing event. */
export function listSeatRequests(root: string, filters: SeatRequestFilters = {}): SeatRequestRow[] {
  const path = ledgerPath(root);
  return [...latestRows(existsSync(path) ? readFileSync(path, 'utf8') : '').values()].filter((row) =>
    (filters.seat === undefined || row.seat === filters.seat)
    && (filters.status === undefined || row.status === filters.status));
}

/** Append at most one terminal event for each distinct, currently open request key. */
export function closeSeatRequests(root: string, keys: readonly string[], options: CloseSeatRequestsOptions): SeatRequestRow[] {
  const reason = options.reason?.trim();
  if (!reason) throw new Error('seat request close requires a reason');
  const status = options.status ?? 'rejected';
  if (status !== 'rejected' && status !== 'done') throw new Error('invalid seat request close status');
  if (options.olderThan !== undefined && (!Number.isSafeInteger(options.olderThan) || options.olderThan < 0)) {
    throw new Error('invalid seat request older-than duration');
  }
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error('invalid seat request close time');
  const path = ledgerPath(root);
  const close = (): SeatRequestRow[] => {
    const latest = latestRows(existsSync(path) ? readFileSync(path, 'utf8') : '');
    const closed = [...new Set(keys)].flatMap((key) => {
      const row = latest.get(key);
      if (!row || (row.status !== 'pending' && row.status !== 'queued')) return [];
      if (options.olderThan !== undefined) {
        const queuedAt = Date.parse(row.queuedAt);
        if (!Number.isFinite(queuedAt) || now.getTime() - queuedAt <= options.olderThan) return [];
      }
      return [{ ...row, status, reason, closedAt: now.toISOString(),
        ...(row.status === 'queued' && typeof row.ref !== 'string' && typeof row.receiptId === 'string'
          ? { ref: row.receiptId } : {}) } satisfies SeatRequestRow];
    });
    if (!options.dryRun) appendSeatRequestRows(path, closed);
    return closed;
  };
  return options.dryRun ? close() : withSeatRequestLedgerLock(path, close);
}
