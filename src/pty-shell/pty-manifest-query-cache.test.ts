import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listPtyManifestRowsCachedAt } from './pty-manifest-query-cache.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('PTY cache reuses raw rows and re-reads the manifest after a store write', () => {
  const root = mkdtempSync(join(tmpdir(), 'pty-manifest-read-cache-'));
  roots.push(root);
  const directory = join(root, 'pty');
  mkdirSync(directory);
  const dbPath = join(directory, 'manifest.db');
  const db = new Database(dbPath);
  db.run('CREATE TABLE pty_manifest (id TEXT PRIMARY KEY, kind TEXT NOT NULL, cmd TEXT NOT NULL, owner_pid INTEGER NOT NULL, instance TEXT NOT NULL, started_at INTEGER NOT NULL, alive INTEGER NOT NULL, updated_at INTEGER NOT NULL)');
  db.run('INSERT INTO pty_manifest (id, kind, cmd, owner_pid, instance, started_at, alive, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ['pty-cache-row', 'tui', 'bun', process.pid, 'tc', 1, 1, 1]);
  db.close();

  const first = listPtyManifestRowsCachedAt(dbPath);
  expect(first.map((row) => row.id)).toEqual(['pty-cache-row']);
  expect(listPtyManifestRowsCachedAt(dbPath)).toEqual(first);

  const writer = new Database(dbPath);
  writer.run('UPDATE pty_manifest SET alive = 0, updated_at = 2 WHERE id = ?', ['pty-cache-row']);
  writer.close();
  const refreshed = listPtyManifestRowsCachedAt(dbPath);
  expect(refreshed[0]).toMatchObject({ id: 'pty-cache-row', alive: false, updatedAt: 2 });
});
