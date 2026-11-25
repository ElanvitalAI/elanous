/**
 * NOTICE-FOLD-1LINE (대표 11-24 12:2x) — an incoming notice row (seat mail · queue notice turn) reads as ONE summary line
 * in the chat, like a folded tool call; a click (or the tool fold key) shows the whole text in place and folds it back.
 *
 * Why: a seat-mail digest is saved as the notice turn's user row (921–13,544 chars live). #39934 cut it to three lines
 * so the previous answer stays on screen; the person asked for the tool-call shape instead — one line, open on click.
 * 대표 12:2x refinement: a mail notice folds PER MESSAGE — each mail of the digest is its own «✉ #id from · first line…»
 * row and opens alone. The spans come from the queue items that built the text (head field `parts`), never from
 * splitting the text. Other machine notices (⏰ 🤖 ⚠) fold to one summary line.
 *
 * The fold rides the tool fold machinery: a notice row is a fold block (`toolFoldBlockStarts`), its index joins the
 * expanded set the renderer reads (`expandedToolIndexes`), and the click lands through `foldTargetAtScreenRow`. Only
 * the expanded state differs: it is kept per row id (`noticeExpanded`), so it survives re-renders and reloads that
 * re-index rows, and is cleared when the session changes. The model and the saved row keep the full text.
 *
 * The person's own lines are never folded (and never styled as a machine row): a row is a notice only by the head our queue wrote (queueNoticeHead),
 * and never when the row says a person sent it. 순수.
 */
import { queueNoticeHead, type QueueNoticeHead, type QueueNoticeMeta, type QueueNoticePart } from '../../chat/interjection.js';
import type { NextTuiQueueMailSpan } from '../core/queue-contract.js';
import type { SerializedMessage } from '../../session/index.js';
import { SEAT_MAIL_DIGEST_HEAD } from '../seat-mail-digest.js';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** The mark that starts a folded seat-mail notice line. */
export const NOTICE_FOLD_MARK = '📩';

/**
 * PERSON-VS-MACHINE (대표 11-24 12:1x) — a machine row (notice · wake · result · system line) never looks like the
 * person: no «❯», a dim foreground and an icon from its structured source (queue source or internal-turn origin).
 * ✉ mail · ⏰ scheduled wake · 🤖 delegated/capsule result · ↻ the seat's own continuation · ⚠ anything else.
 */
export function machineGlyph(source: string | undefined): string {
  switch (source) {
    case 'seat-mail': case 'seat-mail-guide': case 'ceo-ingress': case 'msg-wake': return '📩';
    case 'wakeup': case 'scheduled': case 'retro': case 'pulse': return '⏰';
    case 'capsule-done': case 'harness-child': case 'graph-node': case 'graph-end': case 'sidetab': case 'child-complete': return '🤖';
    case 'goal-continue': case 'autowake': case 'self-pull': return '↻';
    default: return '⚠';
  }
}

/** A machine row's style: dim, or the warning colour when it reports a failure. Applied after fitting (fit strips SGR). */
export function machineRowStyle(line: string, failed = false): string {
  return failed ? `\x1b[33m${line}\x1b[39m` : `\x1b[2m${line}\x1b[22m`;
}
/** Cells the summary's preview (the first meaningful line) keeps. */
export const NOTICE_FOLD_PREVIEW_CELLS = 100;

/** The notice a chat row carries, or null (a person's line, an answer, a tool row, any other row). */
export function noticeOfRow(message: SerializedMessage | undefined): QueueNoticeHead | null {
  if (!message || message.role !== 'user' || message.from?.kind === 'human' || message.interruptionMarker === true) return null;
  return queueNoticeHead(message.content);
}

/** The stable key of a row's expanded state — the saved turn id, else role and time (the transcript row id). */
export function noticeRowId(message: Pick<SerializedMessage, 'turn_id' | 'role' | 'ts'>): string {
  return message.turn_id !== undefined ? String(message.turn_id) : `${message.role}@${message.ts}`;
}

function cutCells(text: string, cells: number): string {
  if (Bun.stringWidth(text) <= cells) return text;
  let out = '';
  let used = 0;
  for (const { segment } of segmenter.segment(text)) {
    const width = Bun.stringWidth(segment);
    if (used + width > cells - 1) break;
    out += segment;
    used += width;
  }
  return `${out}…`;
}

/** The first line that says something: blank lines and the digest's own count header are skipped (the count is in the
 *  summary already), a digest bullet loses its «- », and whitespace runs fold to one space. */
export function noticeFirstLine(body: string): string {
  for (const raw of body.split('\n')) {
    const line = raw.replace(/\s+/gu, ' ').trim();
    if (line.length === 0 || line.startsWith(SEAT_MAIL_DIGEST_HEAD)) continue;
    return line.startsWith('- ') ? line.slice(2) : line;
  }
  return '';
}

/** `✉ <source> · <first sender> +N · <count> msg · <first meaningful line ≤ 100 cells>` — fields the head lacks are left out. */
export function noticeFoldSummary(notice: QueueNoticeHead): string {
  const senders = notice.senders ?? [];
  const count = notice.count ?? (notice.msgIds && notice.msgIds.length > 0 ? notice.msgIds.length : undefined);
  const preview = cutCells(noticeFirstLine(notice.body), NOTICE_FOLD_PREVIEW_CELLS);
  const glyph = (notice.failed ?? 0) > 0 ? '⚠' : machineGlyph(notice.source);
  return [`${glyph} ${notice.source}`,
    ...((notice.failed ?? 0) > 0 ? [`${notice.failed} failed`] : []),
    ...(senders.length > 0 ? [`${senders[0]}${senders.length > 1 ? ` +${senders.length - 1}` : ''}`] : []),
    ...(count !== undefined ? [`${count} msg`] : []),
    ...(preview ? [preview] : [])].join(' · ');
}

/** Display indexes of the notice rows whose id is expanded — what joins `expandedToolIndexes` for this frame. */
export function noticeExpandedIndexes(messages: readonly SerializedMessage[], expanded: ReadonlySet<string>): number[] {
  if (expanded.size === 0) return [];
  const indexes: number[] = [];
  for (const [index, message] of messages.entries()) {
    if (expanded.has(noticeRowId(message)) && noticeOfRow(message)) indexes.push(index);
  }
  return indexes;
}

/** The expanded set a frame renders with: notices by row id, plus the tool blocks (never a notice index held there). */
export function foldExpandedIndexes(
  messages: readonly SerializedMessage[],
  tools: ReadonlySet<number> | null,
  notices: ReadonlySet<string>,
): Set<number> {
  const set = new Set<number>(noticeExpandedIndexes(messages, notices));
  for (const index of tools ?? []) if (!noticeOfRow(messages[index])) set.add(index);
  return set;
}

/** A fold target landed on display row `index`: a notice toggles its row id here (true); anything else is not ours (false). */
export function toggleNoticeFold(expanded: Set<string>, messages: readonly SerializedMessage[], index: number): boolean {
  const message = messages[index];
  if (!message || !noticeOfRow(message)) return false;
  const id = noticeRowId(message);
  if (expanded.has(id)) expanded.delete(id);
  else expanded.add(id);
  return true;
}

/** The structured head fields for a notice leaving the queue (one notice or a bundle): count, senders, ledger ids. */
export function queueNoticeMeta(
  entries: readonly { readonly msgId?: number; readonly sender?: string; readonly failed?: number }[],
  parts: readonly QueueNoticePart[] = [],
): QueueNoticeMeta {
  const senders = [...new Set(entries.flatMap((entry) => entry.sender ? [entry.sender] : []))];
  const msgIds = entries.flatMap((entry) => entry.msgId === undefined ? [] : [entry.msgId]);
  const failed = entries.reduce((sum, entry) => sum + (entry.failed ?? 0), 0);
  return { count: entries.length, ...(senders.length > 0 ? { senders } : {}), ...(msgIds.length > 0 ? { msgIds } : {}),
    ...(failed > 0 ? { failed } : {}), ...(parts.length > 0 ? { parts } : {}) };
}

/**
 * NOTICE-FOLD-1LINE (대표 12:2x) — where each mail of a notice turn's text sits, from the queue items that built it: an
 * action mail's own body inside its block (`bodyAt` · `bodyLength`), an info mail's body inside its digest line. The
 * blocks and lines are found as the exact strings the bundle joined (never a pattern over the text).
 */
export function seatMailNoticeParts(
  text: string,
  notices: readonly { readonly text: string; readonly msgId?: number; readonly passive?: boolean; readonly digest?: string; readonly mail?: NextTuiQueueMailSpan }[],
): QueueNoticePart[] {
  const parts: QueueNoticePart[] = [];
  let blockCursor = 0;
  for (const notice of notices) {
    const mail = notice.mail;
    if (!mail || notice.msgId === undefined) continue;
    const block = notice.passive === true ? -1 : text.indexOf(notice.text, blockCursor);
    if (block >= 0) {
      blockCursor = block + notice.text.length;
      parts.push({ msgId: notice.msgId, sender: mail.sender, start: block + mail.bodyAt, length: mail.bodyLength });
      continue;
    }
    if (notice.digest === undefined) continue;
    const line = text.indexOf(`- ${notice.digest}`);
    if (line >= 0) parts.push({ msgId: notice.msgId, sender: mail.sender, start: line + 2 + mail.digestBodyAt,
      length: notice.digest.length - mail.digestBodyAt });
  }
  return parts.sort((left, right) => left.start - right.start).filter((part) => part.length >= 0 && part.start + part.length <= text.length);
}

/** A mail line: `✉ #<id> <from> · <first line of that message>` truncated to the row width with «…». */
export function noticePartLine(part: QueueNoticePart, messageText: string, columns: number): string {
  const first = messageText.split('\n').map((line) => line.replace(/\s+/gu, ' ').trim()).find((line) => line.length > 0) ?? '';
  return cutCells(`${NOTICE_FOLD_MARK} #${part.msgId} ${part.sender} · ${first}`, Math.max(1, columns));
}

/** The head of an open mail (its text follows on the next rows). */
export const noticePartHead = (part: QueueNoticePart, columns: number): string =>
  cutCells(`${NOTICE_FOLD_MARK} #${part.msgId} ${part.sender} ·`, Math.max(1, columns));

/** The key of one mail's expanded state inside a notice row. */
export const noticePartKey = (rowId: string, msgId: number): string => `${rowId}#${msgId}`;

/** A displayed row that carries which of its mails are open (display only — never saved). */
export type NoticeDisplayRow = SerializedMessage & { readonly noticeOpenParts?: readonly number[] };

/** Mark the open mails on the displayed notice rows; the same array when none is open (keeps the history cache warm). */
export function withNoticeOpenParts(messages: readonly SerializedMessage[], expanded: ReadonlySet<string>): readonly SerializedMessage[] {
  if (![...expanded].some((key) => key.includes('#'))) return messages;
  return messages.map((message) => {
    const notice = noticeOfRow(message);
    if (!notice?.parts) return message;
    const rowId = noticeRowId(message);
    const open = notice.parts.filter((part) => expanded.has(noticePartKey(rowId, part.msgId))).map((part) => part.msgId);
    return open.length > 0 ? { ...message, noticeOpenParts: open } as NoticeDisplayRow : message;
  });
}

/** A fold target on display row `index` (one mail when `part` is set): toggles that mail or the whole notice. */
export function toggleNoticePartFold(expanded: Set<string>, messages: readonly SerializedMessage[], index: number, part: number | undefined): boolean {
  if (part === undefined) return toggleNoticeFold(expanded, messages, index);
  const message = messages[index];
  if (!message || !noticeOfRow(message)) return false;
  const key = noticePartKey(noticeRowId(message), part);
  if (expanded.has(key)) expanded.delete(key);
  else expanded.add(key);
  return true;
}
