import { createHash } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { releaseLedgerRoot } from '../instance/resolve.js';

/** Read only the authoritative SQLite ledger. Never migrate or import legacy JSON here. */
export function readOpChecklistGreen(version: string, root = releaseLedgerRoot()): string {
  if (!/^\d+\.\d+\.\d+(?:-(?:rc|alpha|beta)\.\d+)?$/u.test(version)) throw new Error('invalid checklist version');
  const path = join(root, 'release', 'features.sqlite');
  const legacy = join(root, 'release', version, 'checklist.json');
  // immutable reads only the main database snapshot, deliberately ignoring WAL.
  // The URL encoder prevents filename ?, # and % from becoming URI parameters.
  const uri = `${pathToFileURL(resolve(path)).href}?mode=ro&immutable=1`;
  const db = new Database(uri, { readonly: true, strict: true });
  try {
    db.exec('BEGIN');
    const imported = db.query('SELECT json_hash FROM imported_versions WHERE version = ?').get(version) as { json_hash: string | null } | null;
    if (!imported) throw new Error('checklist version has not been imported');
    if (existsSync(legacy)) {
      const hash = createHash('sha256').update(readFileSync(legacy)).digest('hex');
      if (hash !== imported.json_hash) throw new Error('checklist legacy state is not synchronized');
    }
    const rows = db.query('SELECT status, COUNT(*) AS count FROM assignments WHERE version = ? GROUP BY status').all(version) as Array<{ status: string; count: number }>;
    if (rows.some((row) => !['green', 'yellow', 'red', 'done'].includes(row.status))) throw new Error('invalid checklist status');
    const counts = Object.fromEntries(['green', 'yellow', 'red', 'done'].map((status) => [status, rows.find((row) => row.status === status)?.count ?? 0]));
    db.exec('COMMIT');
    return JSON.stringify({ ...counts, evidence: 'SQLite immutable snapshot 읽기 (최신 WAL 미반영 가능)' });
  } finally { db.close(); }
}
