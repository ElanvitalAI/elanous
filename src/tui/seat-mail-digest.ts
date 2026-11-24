/**
 * SEAT-MAIL-COALESCE-NOTICE — seat mail reaches a turn as ONE digest, and info mail opens no turn of its own.
 *
 * 11-23 audit (ELN-OP-CONTEXT-AUDIT-1123 W2): 182 of 212 OP turns in 4h were seat-mail notices, one full turn each.
 * Here:
 *   - an info-kind mail (kind info · ack · receipt(s) · retro · retro-report) is «passive»: it waits in the queue and rides the
 *     next digest (or opens one after the passive wake window) — it never opens a turn by itself;
 *   - an action mail (request · decision · alert · approval · urgent · anything not listed as info) still opens a turn,
 *     but every seat mail waiting at that boundary is folded into ONE digest text (count + one line per mail);
 *   - after the digest turn completes, the info mails it listed are acked per id (never a cursor move), so the unread
 *     counter only counts action mail still open.
 *
 * Pure module: no queue, no ledger, no timers.
 */
import { legacyIntent } from '../msg/msg-receipts.js';
import { isDecisionMail, isUrgentSeatMail } from './seat-mail-priority.js';

/** Transport kinds that carry information only — listed in a digest, auto-acked after it, never a turn of their own. */
export const SEAT_MAIL_INFO_KINDS: readonly string[] = ['info', 'ack', 'receipt', 'receipts', 'retro', 'retro-report'];

/** Body characters one digest line keeps. */
export const SEAT_MAIL_DIGEST_BODY_CHARS = 120;

/** The first line of a digest turn — the count header (NOTICE-FOLD-1LINE skips it for the folded preview). */
export const SEAT_MAIL_DIGEST_HEAD = '[seat-mail digest]';

/** Idle-door debounce: mail notices arriving within this window of each other open one turn, not several. */
export const SEAT_MAIL_COALESCE_MS = 3_000;

export interface SeatMailDigestInput {
  id: number;
  sender: string;
  body: string;
  kind?: string | null;
  intent?: string | null;
}

/**
 * Info mail = an explicit info kind, no action intent, no urgent mark. A mail with no kind is NOT info (the ledger
 * defaults a kind-less mail to intent info; that default must not silence an ordinary instruction).
 */
export function isInfoSeatMail(message: SeatMailDigestInput): boolean {
  const kind = typeof message.kind === 'string' ? message.kind.trim().toLowerCase() : '';
  if (!SEAT_MAIL_INFO_KINDS.includes(kind)) return false;
  if (isDecisionMail(message) || isUrgentSeatMail({ kind: message.kind ?? null, body: message.body })) return false;
  const intent = message.intent ?? legacyIntent(kind);
  return intent === 'info';
}

/** One digest line: `#id · from · kind · first 120 body chars` (whitespace folded to single spaces). */
export function seatMailDigestLine(message: SeatMailDigestInput): string {
  const flat = message.body.replace(/\s+/gu, ' ').trim();
  const body = flat.length <= SEAT_MAIL_DIGEST_BODY_CHARS ? flat : `${flat.slice(0, SEAT_MAIL_DIGEST_BODY_CHARS)}…`;
  return `${seatMailDigestPrefix(message)}${body}`;
}

/** The digest line's head before the body (`#id · from · kind · `) — NOTICE-FOLD-1LINE finds the body by its length. */
export function seatMailDigestPrefix(message: SeatMailDigestInput): string {
  const kind = typeof message.kind === 'string' && message.kind.trim() !== '' ? message.kind.trim() : '-';
  return `#${message.id} · ${message.sender} · ${kind} · `;
}

/** A notice as it leaves the queue in one bundle (the fields this module reads). */
export interface SeatMailBundleNotice {
  readonly text: string;
  readonly source?: string;
  readonly msgId?: number;
  readonly digest?: string;
  readonly passive?: boolean;
}

/**
 * The one turn text for a notice bundle. Seat mail with a digest line becomes ONE digest block — header with the count,
 * one line per mail, then the full text of each action mail (info mail is the line only). Other notices follow as they
 * are. A bundle of one action mail and nothing else keeps its plain text (no digest wrapper for a single mail).
 */
export function seatMailBundleText(notices: readonly SeatMailBundleNotice[]): string {
  const mail = notices.filter((notice) => notice.source === 'seat-mail' && typeof notice.digest === 'string');
  const rest = notices.filter((notice) => !mail.includes(notice));
  if (mail.length === 0 || (mail.length === 1 && mail[0]!.passive !== true)) return notices.map((notice) => notice.text).join('\n\n');
  const info = mail.filter((notice) => notice.passive === true);
  const action = mail.filter((notice) => notice.passive !== true);
  const header = `${SEAT_MAIL_DIGEST_HEAD} ${mail.length} mails — ${action.length} need action · ${info.length} info (every mail listed here is acked automatically after this turn)`;
  const lines = mail.map((notice) => `- ${notice.digest}`);
  const blocks = action.map((notice) => notice.text);
  return [[header, ...lines].join('\n'), ...blocks, ...rest.map((notice) => notice.text)].join('\n\n');
}
