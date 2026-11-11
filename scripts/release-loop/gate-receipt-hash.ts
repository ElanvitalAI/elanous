import { createHash } from 'node:crypto';
import type { CutSnapshot } from './gate-cut-snapshot.js';
import { gateGitSync } from './gate-git.js';

const SHA40 = /^[a-f0-9]{40}$/i;
const TEST_FILE = /^(?:[\w.-]+\/)*[\w.-]+\.test\.(?:tsx?|jsx?|mts|cts)$/;
const CAT_FILE_MAX_BUFFER = 256 * 1024 * 1024;

export interface GateReceiptHashBatchResult {
  status: number | null;
  stdout: Buffer;
  error?: Error;
}
export type GateReceiptHashBatchRunner = (repo: string, input: Buffer) => GateReceiptHashBatchResult;

function readGitBlobs(repo: string, input: Buffer): GateReceiptHashBatchResult {
  const result = gateGitSync(['cat-file', '--batch=%(objectname) %(objecttype) %(objectsize) %(rest)'], repo,
    { input, maxBuffer: CAT_FILE_MAX_BUFFER });
  return { status: result.status, stdout: Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.alloc(0),
    ...(result.error ? { error: result.error } : {}) };
}

interface ParsedBlobBatch {
  hashes: Map<string, string | null>;
  malformedAt: number | null;
}

/** Keep each complete blob result and identify where a damaged response needs a fresh batch read. */
function parseBlobBatch(stdout: Buffer, commit: string, files: readonly string[]): ParsedBlobBatch {
  const hashes = new Map<string, string | null>();
  let offset = 0;
  let malformedAt: number | null = null;
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index]!;
    const headerEnd = stdout.indexOf(0x0a, offset);
    if (headerEnd < 0) {
      for (const remaining of files.slice(index)) hashes.set(remaining, null);
      malformedAt = index;
      break;
    }
    const header = stdout.toString('ascii', offset, headerEnd);
    if (header === `${commit}:${file} missing`) {
      hashes.set(file, null);
      offset = headerEnd + 1;
      continue;
    }
    const match = /^([a-f0-9]{40}) (\w+) (\d+) (.+)$/i.exec(header);
    if (!match) {
      for (const remaining of files.slice(index)) hashes.set(remaining, null);
      malformedAt = index;
      break;
    }
    if (match[4] !== file) {
      for (const remaining of files.slice(index)) hashes.set(remaining, null);
      malformedAt = index;
      break;
    }
    const size = Number(match[3]);
    if (!Number.isSafeInteger(size) || size < 0) {
      for (const remaining of files.slice(index)) hashes.set(remaining, null);
      malformedAt = index;
      break;
    }
    const contentStart = headerEnd + 1;
    const contentEnd = contentStart + size;
    if (contentEnd >= stdout.length || stdout[contentEnd] !== 0x0a) {
      for (const remaining of files.slice(index)) hashes.set(remaining, null);
      malformedAt = index;
      break;
    }
    const content = stdout.subarray(contentStart, contentEnd);
    if (match[2]!.toLowerCase() === 'blob') {
      const gitBlobId = createHash('sha1').update(`blob ${size}\0`).update(content).digest('hex');
      if (gitBlobId !== match[1]!.toLowerCase()) {
        // The framing is parseable but the record is not trustworthy; quarantine it and re-read later paths.
        for (const remaining of files.slice(index)) hashes.set(remaining, null);
        malformedAt = index;
        break;
      }
      hashes.set(file, createHash('sha256').update(content).digest('hex'));
    } else {
      hashes.set(file, null);
    }
    offset = contentEnd + 1;
  }
  return { hashes, malformedAt };
}

function readBlobBatch(repo: string, commit: string, files: readonly string[], runBatch: GateReceiptHashBatchRunner): GateReceiptHashBatchResult {
  return runBatch(repo, Buffer.from(files.map((file) => `${commit}:${file} ${file}\n`).join(''), 'utf8'));
}

/** Hash all unique shard blobs in one process; one bad shard file never invalidates another shard's hashes. */
export function gateReceiptHashesByShard(repo: string, commit: string, shards: readonly { files: readonly string[] }[],
  runBatch: GateReceiptHashBatchRunner | CutSnapshot = readGitBlobs): { hashesByShard: Record<string, Record<string, string> | null>; batchCount: number } {
  const uniqueFiles = [...new Set(shards.flatMap((shard) => shard.files))].sort();
  const validFiles = SHA40.test(commit) ? uniqueFiles.filter((file) => TEST_FILE.test(file) && !file.split('/').includes('..')) : [];
  let byFile = new Map<string, string | null>(uniqueFiles.map((file) => [file, null]));
  let batchCount = 0;
  if (typeof runBatch !== 'function') {
    if (runBatch.commit !== commit) return { hashesByShard: Object.fromEntries(shards.map((_, index) => [`pod-${index}`, null])), batchCount };
    for (const file of validFiles) {
      const hash = runBatch.entries.get(file)?.sha256;
      byFile.set(file, hash && /^[a-f0-9]{64}$/i.test(hash) ? hash : null);
    }
  } else if (validFiles.length) {
    try {
      batchCount = 1;
      const result = readBlobBatch(repo, commit, validFiles, runBatch);
      // An execution-level failure cannot be repaired by spawning one process per unresolved path.
      if (result.status !== 0 || result.error || !Buffer.isBuffer(result.stdout)) {
        return { hashesByShard: Object.fromEntries(shards.map((_, index) => [`pod-${index}`, null])), batchCount };
      }
      // A partial batch may still contain complete, independently verified earlier blobs.
      const parsed = parseBlobBatch(result.stdout, commit, validFiles);
      byFile = new Map([...byFile, ...parsed.hashes]);
      if (parsed.malformedAt !== null) {
        // cat-file records have no framing after a damaged header/body. Quarantine that path,
        // then batch-read the following suffix so one bad record cannot poison later shards.
        let remaining = validFiles.slice(parsed.malformedAt + 1);
        while (remaining.length) {
          let retry: GateReceiptHashBatchResult;
          try {
            batchCount += 1;
            retry = readBlobBatch(repo, commit, remaining, runBatch);
          } catch {
            break;
          }
          if (retry.status !== 0 || retry.error || !Buffer.isBuffer(retry.stdout)) break;
          const retryParsed = parseBlobBatch(retry.stdout, commit, remaining);
          byFile = new Map([...byFile, ...retryParsed.hashes]);
          if (retryParsed.malformedAt === null) break;
          remaining = remaining.slice(retryParsed.malformedAt + 1);
        }
      }
    } catch {
      // The prefilled nulls preserve per-file fail-closed behavior without discarding other shards.
    }
  }
  const hashesByShard = Object.fromEntries(shards.map((shard, index) => {
    const hashes = shard.files.length > 0 && shard.files.every((file) => typeof byFile.get(file) === 'string')
      ? Object.fromEntries(shard.files.map((file) => [file, byFile.get(file)! as string]))
      : null;
    return [`pod-${index}`, hashes];
  }));
  return { hashesByShard, batchCount };
}
