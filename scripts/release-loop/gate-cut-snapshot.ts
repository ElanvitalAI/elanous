import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gateGitSync } from './gate-git.js';

const SHA40 = /^[a-f0-9]{40}$/i;
const SNAPSHOT_FORMAT_VERSION = 2;
// 출처: #134519 — cap transient per-batch output while retaining a whole immutable cut snapshot.
const SNAPSHOT_BATCH_BYTES = 16 * 1024 * 1024;
const SNAPSHOT_FILE = /(?:\.test\.(?:tsx?|jsx?|mts|cts)$|\.(?:[cm]?[jt]sx?|jsonc?|ya?ml|toml)$|(?:^|\/)package\.json$|(?:^|\/)bun\.lock(?:b)?$|(?:^|\/)Dockerfile$)/i;
export interface CutSnapshotEntry { blob: string; size: number; sha256: string; content: string }
export interface CutSnapshot { commit: string; entries: ReadonlyMap<string, CutSnapshotEntry>; files: readonly string[]; read(path: string): string | undefined; existsBlob(path: string): boolean }
const cache = new Map<string, CutSnapshot>();
export function cachedCutSnapshot(repo: string, commit: string): CutSnapshot | undefined { return cache.get(repo + String.fromCharCode(0) + commit); }

/** Build one immutable view of a cut from the local mirror with bounded ordinary blob batches. */
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
    const listed = gateGitSync(['ls-tree', '-r', '-l', '-z', commit], repo, { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
    if (listed.status !== 0 || listed.error) throw new Error(`CutSnapshot ls-tree failed: ${(listed.stderr || listed.error || '').toString().trim()}`);
    const rows: Array<{ path: string; oid: string; size: number }> = [];
    const files: string[] = [];
    for (const row of (listed.stdout as Buffer).toString('utf8').split('\0').filter(Boolean)) {
      const match = /^(\d+) (blob|commit) ([a-f0-9]{40})\s+(\d+|-)\t(.+)$/.exec(row);
      if (!match) continue;
      files.push(match[5]!);
      if (match[2] === 'blob' && SNAPSHOT_FILE.test(match[5]!)) {
        const size = Number(match[4]);
        if (!Number.isSafeInteger(size) || size < 0) throw new Error(`CutSnapshot invalid blob size: ${match[5]}`);
        rows.push({ path: match[5]!, oid: match[3]!, size });
      }
    }
    const entries: Record<string, CutSnapshotEntry> = {};
    for (const chunk of cutSnapshotBatches(rows)) {
      const batch = gateGitSync(['cat-file', '--batch'], repo, { input: chunk.map((row) => row.oid).join('\n') + '\n', maxBuffer: 2 * 1024 * 1024 * 1024 });
      if (batch.status !== 0 || batch.error || !Buffer.isBuffer(batch.stdout)) throw new Error(`CutSnapshot cat-file failed: ${(batch.stderr || batch.error || '').toString().trim()}`);
      const out = batch.stdout as Buffer;
      let offset = 0;
      for (const row of chunk) {
        const headerEnd = out.indexOf(10, offset);
        if (headerEnd < 0) throw new Error('CutSnapshot batch header truncated');
        const header = out.subarray(offset, headerEnd).toString('ascii');
        const match = /^([a-f0-9]{40}) blob (\d+)$/.exec(header);
        if (!match || match[1] !== row.oid || Number(match[2]) !== row.size) throw new Error(`CutSnapshot blob mismatch: ${row.path}`);
        const size = row.size; const start = headerEnd + 1; const end = start + size;
        if (end >= out.length || out[end] !== 10) throw new Error(`CutSnapshot blob truncated: ${row.path}`);
        const content = out.subarray(start, end);
        entries[row.path] = { blob: row.oid, size, sha256: createHash('sha256').update(content).digest('hex'), content: content.toString('base64') };
        offset = end + 1;
      }
      if (offset !== out.length) throw new Error('CutSnapshot batch has unexpected trailing data');
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

/** Keep ordinary response buffers small; one larger blob remains intact and measured. */
export function cutSnapshotBatches<T extends { size: number }>(rows: readonly T[], budget = SNAPSHOT_BATCH_BYTES): T[][] {
  if (!Number.isSafeInteger(budget) || budget < 1) throw new Error('invalid snapshot batch budget');
  const batches: T[][] = [];
  let current: T[] = [], bytes = 0;
  for (const row of rows) {
    if (!Number.isSafeInteger(row.size) || row.size < 0) throw new Error('invalid snapshot blob size');
    // A cat-file response also carries a sha, type, length and newline per blob.
    const cost = row.size + 80; // 출처: #134519 — conservative Git batch header accounting
    if (current.length && bytes + cost > budget) { batches.push(current); current = []; bytes = 0; }
    current.push(row); bytes += cost;
  }
  if (current.length) batches.push(current);
  return batches;
}
