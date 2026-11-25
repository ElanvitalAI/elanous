import type { SerializedMessage } from '../session/index.js';

/**
 * SEAT-REPLY-DELTA-ONLY (대표 11-25 «eln OP repeats the same content like a parrot») — a turn opened by seat mail, a
 * notice or a self-wake (never a person) that answers with nearly the same text as the previous answer is folded to
 * one line «변화 없음 · <new lines only> · 다음 <HH:MM>». The full text stays in the ledger row (`replyDeltaFull`);
 * the row's `content` — what the screen shows and what the next turn replays to the model — is the folded line, so
 * the model stops imitating its own status summary.
 * Three faces: observe = `tui.reply delta-folded {similarity}` · judge = {@link foldRepeatedReply} · repair = the
 * ledger rewrite in entry's settle path (full text kept, human turns never touched).
 */

/** Token-set Jaccard at or above this is «the same answer again». */
export const REPLY_DELTA_SIMILARITY = 0.7;
/** At most this many new lines ride the folded line. */
const MAX_NEW_FACTS = 3;
const MAX_FACT_CHARS = 120;

const normLine = (line: string): string => line.toLowerCase().replace(/[\s·•\-*#>|`_~:,.()[\]«»"'!?]+/gu, ' ').trim();
const tokens = (text: string): Set<string> => new Set(normLine(text).split(' ').filter((token) => token.length > 0));
const lines = (text: string): string[] => text.split('\n').map((line) => line.trim()).filter((line) => normLine(line).length > 0);

/** Normalized token-set Jaccard of two texts (0..1). */
export function replySimilarity(a: string, b: string): number {
  const left = tokens(a);
  const right = tokens(b);
  if (left.size === 0 && right.size === 0) return 1;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/** The «다음 점검 HH:MM» time the reply names, if any (the last one wins). */
function nextTime(text: string): string | null {
  const found = [...text.matchAll(/다음[^\n\d]{0,12}(\d{1,2}:\d{2})|next[^\n\d]{0,16}(\d{1,2}:\d{2})/giu)];
  const last = found.at(-1);
  return last ? (last[1] ?? last[2] ?? null) : null;
}

export interface ReplyFold { folded: string; similarity: number; sameFirstLine: boolean }

/** Fold `next` against `previous` when it repeats it; `null` = a real change, keep the answer as written. */
export function foldRepeatedReply(previous: string, next: string): ReplyFold | null {
  const prevLines = lines(previous);
  const nextLines = lines(next);
  if (prevLines.length === 0 || nextLines.length === 0) return null;
  const similarity = Math.round(replySimilarity(previous, next) * 100) / 100;
  const sameFirstLine = normLine(prevLines[0]!) === normLine(nextLines[0]!);
  if (similarity < REPLY_DELTA_SIMILARITY && !sameFirstLine) return null;
  const seen = new Set(prevLines.map(normLine));
  const time = nextTime(next);
  const facts = nextLines.slice(1)
    .filter((line) => !seen.has(normLine(line)) && (time === null || !line.includes(time)))
    .slice(0, MAX_NEW_FACTS)
    .map((line) => line.replace(/^[-*•\s]+/u, '').slice(0, MAX_FACT_CHARS));
  const folded = ['변화 없음', ...facts, ...(time === null ? [] : [`다음 ${time}`])].join(' · ');
  return { folded, similarity, sameFirstLine };
}

/** The text a final answer row stood for (a folded row compares by its kept full text). */
const fullText = (row: SerializedMessage): string => row.replyDeltaFull ?? row.content;
const isFinalAnswer = (row: SerializedMessage): boolean => row.role === 'assistant' && row.replyFinal === true && row.goalInterim !== true;

/**
 * Settle-time fold over a session ledger: the newest final answer against the final answer before it.
 * `autoTurn` false (a person opened the turn) never folds. Returns the rewritten rows, or `null` for no change.
 */
export function foldLedgerReply(messages: readonly SerializedMessage[], autoTurn: boolean):
  { messages: SerializedMessage[]; fold: ReplyFold } | null {
  if (!autoTurn) return null;
  let last = -1;
  for (let index = messages.length - 1; index >= 0 && last < 0; index -= 1) if (isFinalAnswer(messages[index]!)) last = index;
  if (last < 0 || messages[last]!.replyDeltaFull !== undefined) return null;
  let prev = -1;
  for (let index = last - 1; index >= 0 && prev < 0; index -= 1) if (isFinalAnswer(messages[index]!)) prev = index;
  if (prev < 0) return null;
  const fold = foldRepeatedReply(fullText(messages[prev]!), messages[last]!.content);
  if (fold === null) return null;
  const rows = [...messages];
  rows[last] = { ...messages[last]!, content: fold.folded, replyDeltaFull: messages[last]!.content };
  return { messages: rows, fold };
}
