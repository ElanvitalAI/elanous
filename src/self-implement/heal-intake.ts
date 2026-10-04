import { appendFileSync, mkdirSync, readFileSync, rmdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { debug } from '../debug/log.js';

export type FailureSource = 'release-run' | 'harness-run' | 'loop-tick' | 'cron';

export interface FailureEvent {
  source: FailureSource;
  kind: string;
  ref: string;
  summary: string;
  at: string;
}

const FOLD_WINDOW_MS = 60 * 60 * 1_000;

function inboxPath(root: string): string {
  return join(root, 'heal', 'inbox.jsonl');
}

function readInbox(file: string): FailureEvent[] {
  let content: string;
  try { content = readFileSync(file, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return content.split('\n').filter(Boolean).map(line => JSON.parse(line) as FailureEvent);
}

/** Lock the read/fold/append transaction across processes, not just within one runner. */
function withInboxLock<T>(file: string, work: () => T): T {
  mkdirSync(dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  const deadline = Date.now() + 5_000;
  for (;;) {
    try { mkdirSync(lock); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 60_000) {
          rmdirSync(lock);
          continue;
        }
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
      }
      if (Date.now() >= deadline) throw new Error(`heal inbox lock is held: ${file}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try { return work(); }
  finally { rmdirSync(lock); }
}

/** One durable JSON line per failure; repeat source+ref within an hour is folded. */
export function recordFailureEvent(event: FailureEvent, root = effectiveInstanceRoot()): { folded: boolean } {
  if (!['release-run', 'harness-run', 'loop-tick', 'cron'].includes(event.source) ||
      !event.kind || !event.ref || !event.summary || !Number.isFinite(Date.parse(event.at))) {
    throw new Error('invalid heal failure event');
  }
  const file = inboxPath(root);
  const folded = withInboxLock(file, () => {
    const incoming = Date.parse(event.at);
    if (readInbox(file).some(previous => previous.source === event.source && previous.ref === event.ref &&
      incoming - Date.parse(previous.at) >= 0 && incoming - Date.parse(previous.at) < FOLD_WINDOW_MS)) return true;
    appendFileSync(file, JSON.stringify(event) + '\n');
    return false;
  });
  debug.log('heal.intake', 'recorded', { source: event.source, kind: event.kind, ref: event.ref, folded });
  return { folded };
}

export function readFailureInbox({ since }: { since?: string } = {}, root = effectiveInstanceRoot()): FailureEvent[] {
  const threshold = since === undefined ? -Infinity : Date.parse(since);
  if (Number.isNaN(threshold)) throw new Error('invalid heal inbox since');
  return readInbox(inboxPath(root)).filter(event => Date.parse(event.at) >= threshold);
}
