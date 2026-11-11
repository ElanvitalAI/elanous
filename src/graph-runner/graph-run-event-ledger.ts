import { appendFileSync, existsSync, readFileSync, statSync, truncateSync, watch } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { GraphEvent } from './graph-events.js';

export function graphRunEventLedgerPath(root: string, graphId: string, runId: string): string {
  if (![graphId, runId].every(value => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && value !== '..'))
    throw new Error('invalid graph run identity');
  return join(root, 'graph-runs', graphId, `${runId}.events.jsonl`);
}

export function readGraphRunEvents(path: string, afterSequence = 0, type?: string): GraphEvent[] {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf8').split('\n');
  // An interrupted append may leave a partial final line. The next write or repair can finish it.
  lines.pop();
  const events = lines.filter(Boolean).map((line) => JSON.parse(line) as GraphEvent);
  for (let index = 0; index < events.length; index++) {
    const event = events[index]!;
    if (!Number.isSafeInteger(event.sequence) || event.sequence <= 0 ||
        (index > 0 && event.sequence <= events[index - 1]!.sequence) ||
        typeof event.eventId !== 'string' || typeof event.runId !== 'string')
      throw new Error(`invalid graph event ledger: ${path}`);
  }
  return events.filter(event => event.sequence > afterSequence && (type === undefined || event.type === type));
}

/** The runner owns one run ledger; retries of a pending envelope keep its original sequence. */
const tails = new Map<string, { size: number; last?: GraphEvent; ids: Set<string> }>();

export function appendGraphRunEvent(path: string, event: GraphEvent): void {
  let size = existsSync(path) ? statSync(path).size : 0;
  let tail = tails.get(path);
  if (!tail || tail.size !== size) {
    const contents = size ? readFileSync(path) : Buffer.alloc(0);
    if (contents.length && contents.at(-1) !== 10) {
      size = contents.lastIndexOf(10) + 1;
      truncateSync(path, size);
    }
    const events = readGraphRunEvents(path);
    tail = { size, last: events.at(-1), ids: new Set(events.map(saved => saved.eventId)) };
    tails.set(path, tail);
  }
  if (tail.ids.has(event.eventId)) return;
  if (tail.last && event.sequence <= tail.last.sequence) {
    throw new Error(`graph event sequence regressed: ${event.eventId}`);
  }
  const line = `${JSON.stringify(event)}\n`;
  appendFileSync(path, line, { mode: 0o600 });
  tail.size += Buffer.byteLength(line);
  tail.last = event;
  tail.ids.add(event.eventId);
}

/** Replay first, then receive every append by watching the run's directory. No timer or polling. */
export async function* watchGraphRunEvents(
  root: string, graphId: string, runId: string,
  options: { afterSequence?: number; type?: string; follow?: boolean; signal?: AbortSignal } = {},
): AsyncGenerator<GraphEvent> {
  const path = graphRunEventLedgerPath(root, graphId, runId);
  const statePath = join(dirname(path), `${runId}.json`);
  if (!existsSync(statePath)) throw new Error(`no run: ${graphId}/${runId}`);
  const complete = () => {
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as { status?: string };
    return state.status === 'done' || state.status === 'failed' || state.status === 'cancelled' || state.status === 'budget-exceeded';
  };
  let sequence = options.afterSequence ?? 0;
  const drain = () => {
    const events = readGraphRunEvents(path, sequence);
    if (events.length) sequence = events.at(-1)!.sequence;
    return events.filter(event => options.type === undefined || event.type === options.type);
  };
  if (!options.follow) { for (const event of drain()) yield event; return; }
  let changed = false;
  let wake: (() => void) | undefined;
  const watcher = watch(dirname(path), (_kind, filename) => {
    if (filename !== null && filename !== basename(path) && filename !== basename(statePath)) return;
    changed = true;
    wake?.();
  });
  const abort = () => { changed = true; wake?.(); };
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    for (const event of drain()) yield event;
    if (complete()) {
      for (const event of drain()) yield event;
      return;
    }
    while (!options.signal?.aborted) {
      if (!changed) await new Promise<void>(resolve => { wake = resolve; });
      wake = undefined;
      changed = false;
      for (const event of drain()) yield event;
      if (complete()) {
        for (const event of drain()) yield event;
        return;
      }
    }
  } finally {
    options.signal?.removeEventListener('abort', abort);
    watcher.close();
  }
}
