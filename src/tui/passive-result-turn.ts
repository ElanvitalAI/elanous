import { withPassiveResultContext } from '../chat/interjection.js';
import type { createNextTuiQueue } from './core/queue.js';

// 출처: #126897 Eight bounded result rows ride one real turn; the rest wait for later turns.
export const PASSIVE_RESULT_CARRY_MAX = 8;

type ResultQueue = Pick<ReturnType<typeof createNextTuiQueue>, 'passiveResultNotices' | 'consumePassiveResultNotices'>;

/** Snapshot before the child starts; consume exactly these rows only after its prompt write succeeds. */
export function preparePassiveResultCarry(queue: ResultQueue, text: string): { text: string; count: number; commit(): number } {
  const rows = queue.passiveResultNotices(PASSIVE_RESULT_CARRY_MAX);
  return {
    text: withPassiveResultContext(text, rows.map((row) => row.text)),
    count: rows.length,
    commit: () => queue.consumePassiveResultNotices(rows),
  };
}
