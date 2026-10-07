import type { ContextNowAnswer, ContextNowDeps } from './context-now.js';

const CONTEXT_FIRST_GAP_MS = 6 * 60 * 60 * 1000;
const CONTEXT_UNREADABLE = '맥락 못 읽음';

/** Track every allowed utterance, consuming a pending summary only on a normal turn. */
export function createContextFirstGate({ now, gapMs = CONTEXT_FIRST_GAP_MS }: { now: () => number; gapMs?: number }) {
  const lastUtteranceAt = new Map<string, number>();
  const pending = new Set<string>();
  return {
    note(key: string): void {
      const at = now();
      const previous = lastUtteranceAt.get(key);
      lastUtteranceAt.set(key, at);
      if (previous === undefined || at - previous >= gapMs) pending.add(key);
    },
    take(key: string): boolean {
      return pending.delete(key);
    },
  };
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
