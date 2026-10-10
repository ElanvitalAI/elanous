import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { debug } from '../debug/log.js';
import type { ContextNowAnswer, ContextNowDeps } from './context-now.js';

const CONTEXT_FIRST_GAP_MS = 6 * 60 * 60 * 1000;
const CONTEXT_UNREADABLE = '맥락 못 읽음';

/** Where the last-utterance times survive a daemon restart, so a restart does not read as a first utterance. */
export interface ContextFirstStore {
  load(): Record<string, number>;
  save(lastUtteranceAt: Record<string, number>): void;
}

/** JSON-file store; unreadable or malformed content loads as empty, write failures never block the turn.
 *  Both are logged (`context-first.store`) so a gate that keeps re-arming after restarts can be traced. */
export function createContextFirstFileStore(path: string): ContextFirstStore {
  return {
    load() {
      try {
        const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
        if (!parsed || typeof parsed !== 'object') return {};
        return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, number] => Number.isFinite(entry[1])));
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
          debug.log('context-first.store', 'load-failed', { path, error: err instanceof Error ? err.message : String(err) });
        }
        return {};
      }
    },
    save(lastUtteranceAt) {
      try {
        mkdirSync(dirname(path), { recursive: true });
        // Write-then-rename so a daemon killed mid-write never leaves a torn file (which would re-arm every opening).
        const tmp = `${path}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify(lastUtteranceAt));
        renameSync(tmp, path);
      } catch (err) {
        // Persistence must not block the conversation, but a failure is observed.
        debug.log('context-first.store', 'save-failed', { path, error: err instanceof Error ? err.message : String(err) });
      }
    },
  };
}

/** Track every allowed utterance, consuming a pending summary only on a normal turn. */
export function createContextFirstGate({ now, gapMs = CONTEXT_FIRST_GAP_MS, store }: { now: () => number; gapMs?: number; store?: ContextFirstStore }) {
  const lastUtteranceAt = new Map<string, number>(Object.entries(store?.load() ?? {}));
  const pending = new Set<string>();
  return {
    note(key: string): void {
      const at = now();
      const previous = lastUtteranceAt.get(key);
      lastUtteranceAt.set(key, at);
      // An entry older than the gap behaves like no entry, so it is dropped from the persisted state.
      store?.save(Object.fromEntries([...lastUtteranceAt].filter(([, time]) => at - time < gapMs)));
      if (previous === undefined || at - previous >= gapMs) pending.add(key);
    },
    take(key: string): boolean {
      return pending.delete(key);
    },
  };
}

const OPERATIONAL_QUERY = /발행|릴리[스즈]|배포|버전|상태|현황|스케줄|체크리스트|도는\s*런|돌고\s*있|\brelease\b|\bversion\b|\bstatus\b|\/now\b/i;

/** A question about the operation or the release itself already asks for the ledger, so the opening would only push the answer down. */
export function isOperationalQuery(text: string | undefined): boolean {
  return !!text && OPERATIONAL_QUERY.test(text);
}

export function renderContextFirst(
  read: (options: {}, deps?: ContextNowDeps) => ContextNowAnswer,
  deps: ContextNowDeps | undefined,
  render: (answer: ContextNowAnswer) => string,
): string {
  try {
    return render(read({}, deps));
  } catch {
    return CONTEXT_UNREADABLE;
  }
}
