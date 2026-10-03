import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readdirSync } from 'node:fs';
import { dlopen, FFIType } from 'bun:ffi';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { OUTPUT_KINDS, type OutputKind } from '../exec-requests/default-outputs.js';

export interface OutputEntry {
  kind: OutputKind | 'file';
  title: string;
  path?: string;
  url?: string;
  source: 'exec' | 'field-reel' | 'field-feed';
  sourceId: string;
  seat?: string;
  at: string;
}

type NewOutput = Omit<OutputEntry, 'at'> & { at?: string };
const validKinds = new Set<unknown>([...Object.keys(OUTPUT_KINDS), 'file']);

function kstMonth(at: Date): string {
  return new Date(at.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 7);
}

function ledgerPath(root: string, month: string): string { return join(root, 'outputs', `outputs-${month}.jsonl`); }

function readEntries(file: string): { entries: OutputEntry[]; newline: boolean } {
  let text: string;
  try { text = readFileSync(file, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { entries: [], newline: true };
    throw error;
  }
  const entries: OutputEntry[] = [];
  text.split('\n').forEach((line, index) => {
    if (!line.trim()) return;
    try {
      const entry: unknown = JSON.parse(line);
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)
        || !('source' in entry) || (entry.source !== 'exec' && entry.source !== 'field-reel' && entry.source !== 'field-feed')
        || !('sourceId' in entry) || typeof entry.sourceId !== 'string' || !entry.sourceId
        || !('kind' in entry) || !validKinds.has(entry.kind)
        || !('title' in entry) || typeof entry.title !== 'string' || !entry.title
        || !('at' in entry) || typeof entry.at !== 'string' || !entry.at
        || (!('path' in entry) || typeof entry.path !== 'string' || !entry.path)
          && (!('url' in entry) || typeof entry.url !== 'string' || !entry.url)
        || ('path' in entry && entry.path !== undefined && typeof entry.path !== 'string')
        || ('url' in entry && entry.url !== undefined && typeof entry.url !== 'string')
        || ('seat' in entry && entry.seat !== undefined && typeof entry.seat !== 'string')) throw new Error('invalid output entry');
      entries.push(entry as OutputEntry);
    } catch (error) {
      debug.log('outputs.ledger', 'invalid-line', { line: index + 1, error: String(error) });
    }
  });
  return { entries, newline: !text || text.endsWith('\n') };
}

// Keep the lock inode in place: unlinking it lets a second writer lock a new inode while the first still holds the old one.
const flock = dlopen(process.platform === 'darwin' ? 'libSystem.B.dylib' : 'libc.so.6',
  { flock: { args: [FFIType.int, FFIType.int], returns: FFIType.int } }).symbols.flock;
function acquireLock(file: string): () => void {
  const fd = openSync(`${file}.lock`, 'a+', 0o600);
  const deadline = Date.now() + 5_000;
  try {
    while (flock(fd, 2 | 4) !== 0) {
      if (Date.now() >= deadline) throw new Error('outputs ledger lock timed out');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  } catch (error) { closeSync(fd); throw error; }
  return () => { try { flock(fd, 8); } finally { closeSync(fd); } };
}

/** The optional root keeps writers with an explicitly selected instance in the same universe. */
export function recordOutput(output: NewOutput, root?: string): void {
  try {
    const instanceRoot = root ?? effectiveInstanceRoot();
    const file = ledgerPath(instanceRoot, kstMonth(new Date()));
    mkdirSync(join(instanceRoot, 'outputs'), { recursive: true, mode: 0o700 });
    const release = acquireLock(file);
    try {
      const { entries, newline } = readEntries(file);
      if (entries.some(entry => entry.source === output.source && entry.sourceId === output.sourceId
        && (entry.path ?? entry.url) === (output.path ?? output.url))) return;
      appendFileSync(file, `${newline ? '' : '\n'}${JSON.stringify({ ...output, at: output.at ?? new Date().toISOString() })}\n`, { mode: 0o600 });
      debug.log('outputs.ledger', 'recorded', { source: output.source, kind: output.kind });
    } finally { release(); }
  } catch (error) {
    debug.log('outputs.ledger', 'write-failed', { source: output.source, kind: output.kind, error: String(error) });
  }
}

export function listOutputs({ since, source, limit }: { since?: string; source?: OutputEntry['source']; limit?: number } = {}, root = effectiveInstanceRoot()): OutputEntry[] {
  let months = 0;
  let rows = 0;
  const entries: OutputEntry[] = [];
  const take = (file: string) => {
    try {
      const read = readEntries(file).entries;
      rows += read.length;
      for (const entry of read) {
        if ((!since || entry.at >= since) && (!source || entry.source === source)) entries.push(entry);
      }
    } catch { /* A damaged month does not hide the other months. */ }
  };
  try {
    const dir = join(root, 'outputs');
    const files = readdirSync(dir).filter(name => /^outputs-\d{4}-(0[1-9]|1[0-2])\.jsonl$/.test(name)).sort().reverse();
    // Month names reflect write time, not entry.at; an older file may hold the newest entry.
    for (const name of files) {
      take(join(dir, name));
      months++;
    }
    // The unrotated ledger has no month boundary; its rows can be newer than any monthly row.
    take(join(dir, 'outputs.jsonl'));
  } catch { /* Missing outputs directory. */ }
  entries.sort((a, b) => b.at.localeCompare(a.at));
  debug.log('outputs.ledger', 'rotated-read', { months, rows });
  return entries.slice(0, limit === undefined ? undefined : Math.max(0, limit));
}
