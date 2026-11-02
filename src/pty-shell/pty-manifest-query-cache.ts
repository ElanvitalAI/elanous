import { dirname, join } from 'node:path';
import { readQueryCache } from '../storage/short-lived-read-cache.js';
import { listPtyManifestRowsAt, ptyManifestDbPath, type PtyManifestRow } from './pty-manifest.js';

/** Cache only raw manifest rows; callers must re-evaluate process liveness and run state per invocation. */
export function listPtyManifestRowsCachedAt(dbPath: string): PtyManifestRow[] {
  return readQueryCache({
    root: join(dirname(dbPath), '..', 'cache', 'cli-read-query'),
    key: { command: 'pty-manifest-rows', dbPath },
    sourcePaths: [dbPath, `${dbPath}-wal`],
    ttlMs: 500,
    load: () => listPtyManifestRowsAt(dbPath),
  });
}

export function listPtyManifestRowsCached(): PtyManifestRow[] {
  return listPtyManifestRowsCachedAt(ptyManifestDbPath());
}
