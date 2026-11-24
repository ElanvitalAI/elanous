import { createHash } from 'node:crypto';
import { mkdir, lstat, rmdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Fail-closed local filesystem serialization. The caller owns a private lock root.
 * This only coordinates processes sharing the same filesystem; it is not a Nexus
 * lease and must not be used as cross-host authorization. A crash leaves a lock
 * requiring operator inspection rather than guessing that it is stale.
 */
export async function withLocalCloudHostLock<T>(root: string, hostId: string, work: () => Promise<T>): Promise<T> {
  if (!root || !hostId || hostId !== hostId.trim()) throw new Error('cloud lock: invalid root or host');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode & 0o077) !== 0)
    throw new Error('cloud lock: root must be a private directory');
  const name = createHash('sha256').update(hostId).digest('hex');
  const path = join(root, name);
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('cloud lock: already held');
    throw error;
  }
  const held = await lstat(path);
  try { return await work(); }
  finally {
    const current = await lstat(path);
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== held.dev || current.ino !== held.ino)
      throw new Error('cloud lock: ownership changed; manual inspection required');
    // rmdir removes only the empty directory; no recursive deletion of foreign content.
    await rmdir(path);
  }
}
