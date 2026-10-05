import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { debug } from '../../debug/log.js';
import { getDefaultLogStore, type LogStore } from '../../mss/logging/log-store.js';
import { fromJsonl, type LogRecord } from '../../mss/logging/record.js';

const FILE_LIMIT = 5 * 1024 * 1024;
const TOTAL_LIMIT = 20 * 1024 * 1024;

type Artifact = { path: string; bytes: Buffer };
type Incomplete = { path: string; reason: string };
type ParseResult = Artifact[] | { error: Incomplete[]; artifacts: Artifact[] };

function safeRelativePath(path: string): boolean {
  return Boolean(path) && !path.includes('\0') && !isAbsolute(path) && !path.startsWith('\\') &&
    !/^[A-Za-z]:/.test(path) && !path.includes('\\') &&
    path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function decodePath(token: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(token)) throw new Error('invalid base64url path');
  const raw = Buffer.from(token, 'base64url');
  if (raw.toString('base64url') !== token) throw new Error('invalid base64url path');
  const path = raw.toString('utf8');
  if (!Buffer.from(path, 'utf8').equals(raw)) throw new Error('invalid UTF-8 path');
  return path;
}

/** Reassemble each file independently; a bad file never discards its neighbors. */
export function parsePodArtifactChunks(logs: string): ParseResult {
  const groups = new Map<string, { total: number; chunks: Map<number, string>; reason?: string }>();
  for (const line of logs.split(/\r?\n/)) {
    if (!line.startsWith('ELANOUS_POD_ARTIFACT ')) continue;
    const match = /^ELANOUS_POD_ARTIFACT (\S+) (\d+)\/(\d+) ([A-Za-z0-9+/=]+)$/.exec(line);
    const token = match?.[1] ?? /^ELANOUS_POD_ARTIFACT (\S+)/.exec(line)?.[1];
    if (!token) continue;
    const group = groups.get(token) ?? { total: match ? Number(match[3]) : 0, chunks: new Map<number, string>() };
    groups.set(token, group);
    if (!match) { group.reason = 'malformed chunk'; continue; }
    const part = Number(match[2]);
    const total = Number(match[3]);
    const chunk = match[4]!;
    if (!Number.isSafeInteger(part) || !Number.isSafeInteger(total) || part < 1 || total < 1 || part > total ||
        chunk.length > 8000 || group.total !== total || group.chunks.has(part)) {
      group.reason = 'invalid or duplicate chunk';
    } else {
      group.chunks.set(part, chunk);
    }
  }
  const artifacts: Artifact[] = [];
  const error: Incomplete[] = [];
  let bytesSoFar = 0;
  for (const [token, group] of groups) {
    let path = token;
    let reason = group.reason;
    try {
      path = decodePath(token);
      if (!safeRelativePath(path)) throw new Error('unsafe relative path');
      if (!reason && group.chunks.size !== group.total) reason = 'missing chunk';
      if (!reason) {
        let encoded = '';
        for (let i = 1; i <= group.total; i++) {
          const chunk = group.chunks.get(i);
          if (!chunk) { reason = 'missing chunk'; break; }
          encoded += chunk;
          if (encoded.length > 8 * 1024 * 1024) { reason = 'file too large'; break; }
        }
        if (!reason) {
          const compressed = Buffer.from(encoded, 'base64');
          if (compressed.toString('base64') !== encoded) throw new Error('invalid base64');
          const bytes = gunzipSync(compressed, { maxOutputLength: FILE_LIMIT + 1 });
          if (bytes.length > FILE_LIMIT) reason = 'file too large';
          else if (bytesSoFar + bytes.length > TOTAL_LIMIT) reason = 'total too large';
          else { artifacts.push({ path, bytes }); bytesSoFar += bytes.length; }
        }
      }
    } catch (e) { reason = e instanceof Error ? e.message : String(e); }
    if (reason) error.push({ path, reason });
  }
  return error.length ? { error, artifacts } : artifacts;
}

const POD_LOGS_PATH = 'pod-logs/logs.jsonl';

/** Last measured child ledger context when a failed Pod emitted no terminal JSON. */
export function podNoResultDiagnostic(ledger: string): string | null {
  let stage: string | undefined;
  let round: number | undefined;
  let mustFix: string | undefined;
  for (const line of ledger.split(/\r?\n/)) {
    try {
      const entry = JSON.parse(line) as { event?: unknown; data?: Record<string, unknown> };
      if (!entry || typeof entry !== 'object' || !entry.data || typeof entry.data !== 'object' || typeof entry.event !== 'string' || entry.event === 'pod-ledger-incomplete') continue;
      if (typeof entry.data.round === 'number' && Number.isSafeInteger(entry.data.round)) round = entry.data.round;
      if (entry.event !== 'run-origin') stage = entry.event;
      // `reviewed` carries pointers only (count + finding ids); the text stays in the review artifact.
      if (entry.event === 'reviewed' && typeof entry.data.mustFix === 'number') {
        const ids = Array.isArray(entry.data.findingIds) ? entry.data.findingIds.filter((id): id is string => typeof id === 'string') : [];
        mustFix = `${entry.data.mustFix}${ids.length ? ` ${JSON.stringify(ids)}` : ''}`;
      }
    } catch { /* incomplete ledger line */ }
  }
  return stage ? `child terminal result missing; last ledger stage=${stage}; round=${round ?? 'unknown'}; mustFix=${mustFix ?? 'unknown'}` : null;
}

/** Import valid JSONL log records into the launching host store, with durable per-job line receipts. */
export function importPodLogs(bytes: Buffer, job: string, store: LogStore | null = getDefaultLogStore()): { imported: number; skipped: number } {
  if (!store) return { imported: 0, skipped: 0 };
  const rows: Array<{ rec: LogRecord; surface: string; line: number }> = [];
  let skipped = 0;
  for (const [lineNumber, line] of bytes.toString('utf8').split(/\r?\n/).entries()) {
    if (!line) continue;
    const rec = fromJsonl(line);
    if (!rec || !Number.isFinite(Date.parse(rec.ts))) { skipped++; continue; }
    const data = rec.data && typeof rec.data === 'object' && !Array.isArray(rec.data)
      ? rec.data as Record<string, unknown>
      : rec.data === undefined ? {} : { originalData: rec.data };
    const surface = (rec as LogRecord & { surface?: unknown }).surface;
    rows.push({
      rec: { ...rec, data: { ...data, origin: 'pod', podJob: job } },
      surface: typeof surface === 'string' && surface ? surface : 'pod',
      line: lineNumber,
    });
  }
  return { imported: store.insertPodBatch(job, rows), skipped };
}

function importReturnedLogs(bytes: Buffer, job: string, store: LogStore | null,
  log: (category: string, event: string, data: Record<string, unknown>) => void): void {
  try {
    if (!store) throw new Error('host log store unavailable');
    const imported = importPodLogs(bytes, job, store);
    log('self-implement.pod', 'pod-logs-imported', { job, imported: imported.imported, skipped: imported.skipped });
  } catch (error) {
    debug.log('self-implement.pod', 'pod-logs-import-failed', { job, reason: error instanceof Error ? error.message : String(error) });
  }
}

/** Reject symlink parents as well as lexical traversal; never replace a host file. */
export function collectPodArtifacts(logs: string, { dir, job, log = (c, e, d) => debug.log(c, e, d), logStore = getDefaultLogStore() }: {
  dir: string;
  job: string;
  log?: (category: string, event: string, data: Record<string, unknown>) => void;
  logStore?: LogStore | null;
}): void {
  const parsed = parsePodArtifactChunks(logs);
  const podLogsPath = POD_LOGS_PATH;
  let podLogsReturned = false;
  let podLogsMissingReason = logs.split(/\r?\n/).find((line) => line.startsWith(`ELANOUS_POD_ARTIFACT_SKIPPED ${podLogsPath} `))
    ? 'artifact skipped (size limit or encoding failure)'
    : logs.split(/\r?\n/).find((line) => line.startsWith('ELANOUS_POD_LOGS_UNAVAILABLE '))?.slice('ELANOUS_POD_LOGS_UNAVAILABLE '.length) || 'absent';
  const truncated = logs.split(/\r?\n/).find((line) => line.startsWith('ELANOUS_POD_LOGS_TRUNCATED '));
  if (truncated) {
    const [, originalBytes, keptBytes] = truncated.split(' ');
    log('self-implement.pod', 'pod-logs-truncated', { job, originalBytes: Number(originalBytes), keptBytes: Number(keptBytes) });
  }
  for (const { path, reason } of Array.isArray(parsed) ? [] : parsed.error) {
    log('self-implement.pod', 'artifact-collect-incomplete', { job, path, reason });
    if (path === podLogsPath) podLogsMissingReason = reason;
  }
  for (const { path, bytes } of Array.isArray(parsed) ? parsed : parsed.artifacts) {
    try {
      if (!safeRelativePath(path)) throw new Error('unsafe relative path');
      if (!/^[a-z0-9-]+$/.test(job)) throw new Error('unsafe job name');
      const root = resolve(dir);
      mkdirSync(root, { recursive: true });
      if (lstatSync(root).isSymbolicLink()) throw new Error('symlink parent');
      const destination = resolve(root, job, path);
      if (!destination.startsWith(root + sep) || relative(root, destination).startsWith('..')) throw new Error('unsafe relative path');
      const parts = relative(root, destination).split(sep);
      let parent = root;
      for (const part of parts.slice(0, -1)) {
        if (lstatSync(parent, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('symlink parent');
        parent = join(parent, part);
        const existing = lstatSync(parent, { throwIfNoEntry: false });
        if (existing?.isSymbolicLink()) throw new Error('symlink parent');
        if (!existing) mkdirSync(parent);
        if (!lstatSync(parent).isDirectory()) throw new Error('non-directory parent');
      }
      writeFileSync(destination, bytes, { flag: 'wx' });
      log('self-implement.pod', 'artifact-collected', { job, path, bytes: bytes.length });
      if (path === podLogsPath) {
        podLogsReturned = true;
        const lines = bytes.length ? bytes.toString('utf8').split('\n').length - (bytes.at(-1) === 10 ? 1 : 0) : 0;
        log('self-implement.pod', 'pod-logs-returned', { job, path: destination, lines });
        importReturnedLogs(bytes, job, logStore, log);
      }
    } catch (e) {
      const reason = (e as NodeJS.ErrnoException).code === 'EEXIST' ? 'exists' : e instanceof Error ? e.message : String(e);
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
        log('self-implement.pod', 'artifact-collect-skipped', { job, path, reason });
        if (path === podLogsPath) {
          try {
            const existing = resolve(dir, job, path);
            if (!lstatSync(existing).isSymbolicLink() && readFileSync(existing).equals(bytes)) {
              podLogsReturned = true;
              importReturnedLogs(bytes, job, logStore, log);
            }
          } catch (error) {
            debug.log('self-implement.pod', 'pod-logs-import-failed', { job, reason: error instanceof Error ? error.message : String(error) });
          }
        }
      } else log('self-implement.pod', 'artifact-collect-incomplete', { job, path, reason });
      if (path === podLogsPath) podLogsMissingReason = reason;
    }
  }
  if (!podLogsReturned) log('self-implement.pod', 'pod-logs-missing', { job, reason: podLogsMissingReason });
}
