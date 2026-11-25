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
/**
 * SEAT-MAIL-PASSIVE-DEFAULT — a passive mail's digest line keeps fewer body characters: passive mail is now most of the
 * traffic (status · reply · notice), and its line is the only context it costs (SIM-STEWARD-AB-1125: status share).
 */
export const SEAT_MAIL_PASSIVE_DIGEST_BODY_CHARS = 24;

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
export function seatMailDigestLine(message: SeatMailDigestInput, maxBody: number = SEAT_MAIL_DIGEST_BODY_CHARS): string {
  const flat = message.body.replace(/\s+/gu, ' ').trim();
  const body = flat.length <= maxBody ? flat : `${flat.slice(0, maxBody)}…`;
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
  /** NOTICE-FOLD-1LINE span — the sender and where the body starts inside `digest` (grouped passive lines read it). */
  readonly mail?: { readonly sender: string; readonly digestBodyAt?: number };
}


/**
 * SEAT-MAIL-PASSIVE-DEFAULT — passive mail from one sender with 2+ mails in a bundle folds into ONE line:
 * `- TC-H3 ×3 · #12 status · #15 - · #33 notice`. A sender with one passive mail keeps its own (short) digest line.
 * Every id stays listed (the ack after the turn is per id; `eln msg show <id>` reads a body).
 */
function digestLines(mail: readonly SeatMailBundleNotice[]): string[] {
  const groups = new Map<string, SeatMailBundleNotice[]>();
  const senderOf = (notice: SeatMailBundleNotice): string | null => (notice.passive === true && notice.mail?.sender ? notice.mail.sender : null);
  for (const notice of mail) {
    const sender = senderOf(notice);
    if (sender === null) continue;
    if (!groups.has(sender)) groups.set(sender, []);
    groups.get(sender)!.push(notice);
  }
  const lines: string[] = [];
  for (const notice of mail) {
    const sender = senderOf(notice);
    const group = sender === null ? undefined : groups.get(sender);
    if (!group || group.length === 1) { lines.push(`- ${notice.digest}`); continue; }
    if (group[0] !== notice) continue; // the group line sits where its first mail arrived
    const ids = group.map((member) => {
      const at = member.mail?.digestBodyAt;
      const parts = (typeof at === 'number' ? member.digest!.slice(0, at) : '').split(' · ');
      return `#${member.msgId} ${parts.length >= 3 && parts[2] ? parts[2] : '-'}`;
    });
    lines.push(`- ${sender} ×${group.length} · ${ids.join(' · ')}`);
  }
  return lines;
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
  const lines = digestLines(mail);
  const blocks = action.map((notice) => notice.text);
  return [[header, ...lines].join('\n'), ...blocks, ...rest.map((notice) => notice.text)].join('\n\n');
}
