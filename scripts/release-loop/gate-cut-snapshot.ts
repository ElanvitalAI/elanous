import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const SHA40 = /^[a-f0-9]{40}$/i;
const SNAPSHOT_FORMAT_VERSION = 2;
const SNAPSHOT_FILE = /(?:\.test\.(?:tsx?|jsx?|mts|cts)$|\.(?:[cm]?[jt]sx?|jsonc?|ya?ml|toml)$|(?:^|\/)package\.json$|(?:^|\/)bun\.lock(?:b)?$|(?:^|\/)Dockerfile$)/i;
export interface CutSnapshotEntry { blob: string; size: number; sha256: string; content: string }
export interface CutSnapshot { commit: string; entries: ReadonlyMap<string, CutSnapshotEntry>; files: readonly string[]; read(path: string): string | undefined; existsBlob(path: string): boolean }
const cache = new Map<string, CutSnapshot>();
export function cachedCutSnapshot(repo: string, commit: string): CutSnapshot | undefined { return cache.get(repo + String.fromCharCode(0) + commit); }

/** Build one immutable view of a cut: one tree listing and one content batch from the local mirror. */
export function createCutSnapshot(repo: string, commit: string, artifactDir?: string): CutSnapshot {
  if (!SHA40.test(commit)) throw new Error(`invalid CutSnapshot commit: ${commit}`);
  const key = `${repo}\0${commit}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const artifact = artifactDir ? join(artifactDir, `${commit}.json`) : undefined;
  let data: { formatVersion: number; commit: string; entries: Record<string, CutSnapshotEntry>; files: string[] } | undefined;
  if (artifact) {
    try { const saved = JSON.parse(readFileSync(artifact, 'utf8')) as typeof data;
      if (saved?.commit === commit && saved.formatVersion === SNAPSHOT_FORMAT_VERSION) data = saved; } catch { /* missing or stale artifact: rebuild below */ }
  }
  if (!data) {
    const listed = spawnSync('git', ['ls-tree', '-r', '-z', commit], { cwd: repo, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
    if (listed.status !== 0 || listed.error) throw new Error(`CutSnapshot ls-tree failed: ${(listed.stderr || listed.error || '').toString().trim()}`);
    const rows: Array<{ path: string; oid: string }> = [];
    const files: string[] = [];
    for (const row of (listed.stdout as Buffer).toString('utf8').split('\0').filter(Boolean)) {
      const match = /^(\d+) (blob|commit) ([a-f0-9]{40})\t(.+)$/.exec(row);
      if (!match) continue;
      files.push(match[4]!);
      if (match[2] === 'blob' && SNAPSHOT_FILE.test(match[4]!)) rows.push({ path: match[4]!, oid: match[3]! });
    }
    const batch = spawnSync('git', ['cat-file', '--batch'], { cwd: repo, input: rows.map((row) => row.oid).join('\n') + '\n', maxBuffer: 2 * 1024 * 1024 * 1024 });
    if (batch.status !== 0 || batch.error || !Buffer.isBuffer(batch.stdout)) throw new Error(`CutSnapshot cat-file failed: ${(batch.stderr || batch.error || '').toString().trim()}`);
    const out = batch.stdout as Buffer;
    const entries: Record<string, CutSnapshotEntry> = {};
    let offset = 0;
    for (const row of rows) {
      const headerEnd = out.indexOf(10, offset);
      if (headerEnd < 0) throw new Error('CutSnapshot batch header truncated');
      const header = out.subarray(offset, headerEnd).toString('ascii');
      const match = /^([a-f0-9]{40}) blob (\d+)$/.exec(header);
      if (!match || match[1] !== row.oid) throw new Error(`CutSnapshot blob mismatch: ${row.path}`);
      const size = Number(match[2]); const start = headerEnd + 1; const end = start + size;
      if (!Number.isSafeInteger(size) || end >= out.length || out[end] !== 10) throw new Error(`CutSnapshot blob truncated: ${row.path}`);
      const content = out.subarray(start, end);
      entries[row.path] = { blob: row.oid, size, sha256: createHash('sha256').update(content).digest('hex'), content: content.toString('base64') };
      offset = end + 1;
    }
    data = { formatVersion: SNAPSHOT_FORMAT_VERSION, commit, entries, files: files.sort() };
    if (artifact) {
      mkdirSync(dirname(artifact), { recursive: true });
      const tmp = `${artifact}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(data)); renameSync(tmp, artifact);
    }
  }
  const entries = new Map(Object.entries(data.entries));
  const snapshot: CutSnapshot = { commit, entries, files: data.files,
    read: (path) => { const row = entries.get(path); return row ? Buffer.from(row.content, 'base64').toString('utf8') : undefined; },
    existsBlob: (path) => entries.has(path) };
  cache.set(key, snapshot);
  return snapshot;
}
