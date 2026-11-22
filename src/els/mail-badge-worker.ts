// ELS-SERVER-MAINLOOP-STARVATION — the mail-ledger badge read, off the els server's main thread.
// The els server thread handles every keystroke, attach frame and `els ls`; a synchronous bun:sqlite read of the mail
// ledger (131 MB · ~127k rows · one COUNT per seat) on it stalled input ~200 ms per key. This worker owns that read:
// one read-only connection, kept open, and a recompute only when the ledger changed (`PRAGMA data_version` moves when
// another connection commits), the seat set changed, the file was replaced, or the caller asks for a periodic recount
// (expiry is time-based, so no write may be the reason a badge changes).
// Never writes the ledger. A failed read (busy/locked, or any SQL error) is an error answer — the caller keeps its last badges.
import { existsSync, statSync } from 'node:fs';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { Database } from 'bun:sqlite';
import { readUnreadMailBadgesOn, type UnreadMailBadge } from '../msg/msg-store.js';

export const MAIL_BADGE_WORKER_KIND = 'els-mail-badge';

export interface MailBadgeRequest { readonly path: string; readonly seats: readonly string[]; readonly force: boolean }
export type MailBadgeAnswer =
  | { readonly ok: true; readonly changed: false }
  | { readonly ok: true; readonly changed: true; readonly badges: ReadonlyArray<readonly [string, UnreadMailBadge | null]> }
  | { readonly ok: false; readonly error: string };

/** Off the main thread a locked ledger may be waited on a little longer than the old in-request 100 ms. */
const WORKER_BUSY_TIMEOUT_MS = 2_000;

/** The reader the worker runs (exported so a test can drive it in-process). */
export function createMailBadgeReader(busyTimeoutMs: number = WORKER_BUSY_TIMEOUT_MS) {
  let conn: { db: Database; path: string; ino: number; dev: number } | null = null;
  let last: { version: number; key: string } | null = null;
  const close = (): void => {
    try { conn?.db.close(); } catch { /* already closed */ }
    conn = null;
    last = null;
  };
  const read = (request: MailBadgeRequest): MailBadgeAnswer => {
    try {
      const seats = [...new Set(request.seats)];
      if (!existsSync(request.path)) {
        close();
        return { ok: true, changed: true, badges: seats.map((seat) => [seat, null] as const) };
      }
      const stat = statSync(request.path);
      // A replaced file (new inode) is a different ledger: the old connection would keep reading the unlinked one.
      if (conn && (conn.path !== request.path || conn.ino !== stat.ino || conn.dev !== stat.dev)) close();
      if (!conn) {
        const db = new Database(request.path, { readonly: true });
        db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(busyTimeoutMs))}`);
        conn = { db, path: request.path, ino: stat.ino, dev: stat.dev };
      }
      const version = (conn.db.query('PRAGMA data_version').get() as { data_version: number }).data_version;
      const key = [...seats].sort().join('\n');
      if (!request.force && last && last.version === version && last.key === key) return { ok: true, changed: false };
      const { badges, error } = readUnreadMailBadgesOn(conn.db, seats);
      // JUD-B #39546 must ②: a failed read (busy or any SQL error) is a failure — the caller keeps its last badges and
      // the stored version is forgotten, so the next request reads again instead of answering «unchanged».
      if (error !== null) { last = null; return { ok: false, error }; }
      last = { version, key };
      return { ok: true, changed: true, badges: [...badges.entries()] };
    } catch (error) {
      close();
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };
  return { read, close };
}

const port = parentPort;
if (!isMainThread && port && (workerData as { kind?: string } | undefined)?.kind === MAIL_BADGE_WORKER_KIND) {
  const reader = createMailBadgeReader();
  port.on('message', (message: MailBadgeRequest & { id: number }) => {
    port.postMessage({ id: message.id, ...reader.read(message) });
  });
}
