import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** A persistent at-most-once claim; uncertain/failed actions require reconciliation.
 * Never expire or steal a claim based on a timer: the prior side effect may have run. */
export async function claimScheduledGraphAction(input: {
  path: string; version: string; cutAt: string; phase: 'create' | 'cut';
  run: () => Promise<void>;
}): Promise<'done' | 'already-claimed'> {
  mkdirSync(dirname(input.path), { recursive: true });
  const db = new Database(input.path, { create: true });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec(`CREATE TABLE IF NOT EXISTS scheduled_graph_claims (
      version TEXT NOT NULL, cut_at TEXT NOT NULL, phase TEXT NOT NULL,
      status TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (version, cut_at, phase))`);
    const inserted = db.query(`INSERT OR IGNORE INTO scheduled_graph_claims
      (version, cut_at, phase, status, updated_at) VALUES (?, ?, ?, 'pending', ?)`)
      .run(input.version, input.cutAt, input.phase, new Date().toISOString());
    if (!inserted.changes) return 'already-claimed';
    try {
      await input.run();
      db.query(`UPDATE scheduled_graph_claims SET status = 'done', updated_at = ? WHERE version = ? AND cut_at = ? AND phase = ?`)
        .run(new Date().toISOString(), input.version, input.cutAt, input.phase);
      return 'done';
    } catch (error) {
      db.query(`UPDATE scheduled_graph_claims SET status = 'uncertain', updated_at = ? WHERE version = ? AND cut_at = ? AND phase = ?`)
        .run(new Date().toISOString(), input.version, input.cutAt, input.phase);
      throw error;
    }
  } finally { db.close(); }
}
