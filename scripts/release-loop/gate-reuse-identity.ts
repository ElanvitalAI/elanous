import { createHash } from 'node:crypto';
import { cachedCutSnapshot } from './gate-cut-snapshot.js';
import { spawnSync } from 'node:child_process';
import { SPAWN_SYNC_MAX_BUFFER } from '../../src/util/spawn-sync-output.js';

const SHA40 = /^[a-f0-9]{40}$/i;
const TEST_FILE = /^(?:[\w.-]+\/)*[\w.-]+\.test\.(?:tsx?|jsx?|mts|cts)$/;

/** Hash exactly the test-file blobs named by a shard at the commit that produced its result. */
export function gateTestedFileHashesAtCommit(repo: string, commit: string, files: readonly string[]): Record<string, string> | null {
  if (!SHA40.test(commit) || !files.length || new Set(files).size !== files.length || files.some((file) => !TEST_FILE.test(file) || file.split('/').includes('..'))) return null;
  const hashes: Record<string, string> = {};
  const snapshot = cachedCutSnapshot(repo, commit);
  for (const file of [...files].sort()) {
    const hash = snapshot?.entries.get(file)?.sha256;
    if (snapshot && (!hash || !/^[a-f0-9]{64}$/i.test(hash))) return null;
    const result = snapshot ? null : spawnSync('git', ['show', commit + ':' + file], { cwd: repo, maxBuffer: SPAWN_SYNC_MAX_BUFFER });
    if (result && (result.status !== 0 || result.error || !Buffer.isBuffer(result.stdout))) return null;
    hashes[file] = snapshot ? hash! : createHash('sha256').update(result!.stdout).digest('hex');
  }
  return hashes;
}

/** Lockfile identity is a named component of the runtime reuse tuple. */
export function gateLockfileHashAtCommit(repo: string, commit: string): string | null {
  if (!SHA40.test(commit)) return null;
  const files = ['bun.lock', 'apps/pwa/bun.lock'];
  const snapshot = cachedCutSnapshot(repo, commit);
  const contents: Buffer[] = [];
  for (const file of files) {
    const entry = snapshot?.entries.get(file);
    if (snapshot && !entry) return null;
    if (snapshot) contents.push(Buffer.from(entry!.content, 'base64'));
    else {
      const result = spawnSync('git', ['show', commit + ':' + file], { cwd: repo, maxBuffer: SPAWN_SYNC_MAX_BUFFER });
      if (result.status !== 0 || result.error || !Buffer.isBuffer(result.stdout)) return null;
      contents.push(result.stdout);
    }
  }
  return createHash('sha256').update(Buffer.concat(contents.flatMap((content, index) => [contents[index]!, Buffer.from('\0')]))).digest('hex');
}

export function sameGateTestedFileHashes(a: Readonly<Record<string, string>> | undefined,
  b: Readonly<Record<string, string>> | undefined): boolean {
  if (!a || !b) return false;
  const ak = Object.keys(a).sort(), bk = Object.keys(b).sort();
  return JSON.stringify(ak) === JSON.stringify(bk) && ak.every((key) => /^[a-f0-9]{64}$/i.test(a[key] ?? '') && a[key] === b[key]);
}
