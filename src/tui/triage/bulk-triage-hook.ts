/**
 * BULK-TRIAGE hook — the adapter between the queue's notice bundle (or a person's long text) and the pure card.
 *
 * - a bundle of ≥ 3 notices → one card at the head of the bundle turn text;
 * - a human text ≥ 400 chars with ≥ 3 asks → one card at the head, the person's text untouched after it;
 * - each card logs `triage.bulk-card {items, p0, p1, p2, p3, noise, groups, folded}`.
 *
 * Classification reads the structured `triage` meta a seat-mail notice carries (set by the producer from ledger
 * columns). Mail the queue folded past its cap arrives inside a `seat-mail-guide` notice: its lines carry the same
 * `[from SEAT · intent( · crown)]` header and `msg:<id>` that the producer wrote, so they are read back from that
 * format (never from free prose). An arrival-level guide (`ids #a..#b`) becomes a folded range (counted, not lost).
 */
import { debug } from '../../debug/log.js';
import type { NextTuiQueueNoticeEntry, NextTuiQueueTriageMeta } from '../core/queue-contract.js';
import {
  BULK_TRIAGE_MIN_ITEMS, buildBulkTriageCard, humanTextNeedsTriage, withBulkTriageCard,
  type BulkTriageCard, type BulkTriageFoldedRange, type BulkTriageMail,
} from './bulk-triage.js';

export type BulkTriageLog = (event: string, data: Record<string, unknown>) => void;
const defaultLog: BulkTriageLog = (event, data) => debug.log('triage', event, data);

const HEADER = /\[from ([^\s·\]]+) · ([a-z-]+)( · crown)?\]/u;
const MSG_ID = /msg:(\d+) · /u;
const RANGE = /ids #(\d+)\.\.#(\d+)/u;
const FOLDED_COUNT = /(\d+)\+? more unread mails/u;

/** A queue-folded mail line (`- <flat notice text>`) → a triage mail, or null when it carries no msg id. */
export function foldedLineToMail(line: string): BulkTriageMail | null {
  const id = MSG_ID.exec(line);
  if (!id) return null;
  const head = HEADER.exec(line);
  const body = line.slice(id.index + id[0].length).replace(/<\/federation_work_order>.*$/u, '').trim();
  return { msgId: Number(id[1]), from: head?.[1] ?? '?', intent: head?.[2] ?? null, ...(head?.[3] ? { crownDirective: 'folded' } : {}), body };
}

function mailOfMeta(t: NextTuiQueueTriageMeta, msgId: number | undefined, replyTo: number | undefined): BulkTriageMail {
  return { ...(msgId === undefined ? {} : { msgId }), from: t.from, to: t.to ?? null, intent: t.intent ?? null, kind: t.kind ?? null,
    crownDirective: t.crownDirective ?? null, originKind: t.originKind ?? null, replyTo: replyTo ?? null,
    deadline: t.deadline ?? null, priority: t.priority ?? null, body: t.body };
}

/** The triage input of one drained notice bundle. */
export function triageInputOfNotices(notices: readonly NextTuiQueueNoticeEntry[]): { mails: BulkTriageMail[]; folded: BulkTriageFoldedRange[] } {
  const mails: BulkTriageMail[] = [];
  const folded: BulkTriageFoldedRange[] = [];
  // Every notice in one queue is addressed to this seat — a text-only folded line borrows it (self-wake detection).
  const seat = notices.find((n) => n.triage?.to)?.triage?.to;
  for (const n of notices) {
    if (n.source === 'seat-mail' && n.triage) {
      mails.push(mailOfMeta({ ...n.triage, ...(n.triage.intent || !n.mailIntent ? {} : { intent: n.mailIntent }) }, n.msgId, n.replyTo));
      continue;
    }
    if (n.source === 'seat-mail-guide') {
      const range = RANGE.exec(n.text);
      if (range) {
        const first = Number(range[1]); const last = Number(range[2]);
        const count = Number(FOLDED_COUNT.exec(n.text)?.[1] ?? last - first + 1);
        folded.push({ first, last, count });
      }
      if (n.foldedMail?.length) {
        // The queue kept each folded mail's structured fields — the same ranking as a mail listed on its own.
        for (const f of n.foldedMail) mails.push(f.triage ? mailOfMeta(f.triage, f.msgId, f.replyTo) : { ...(f.msgId === undefined ? {} : { msgId: f.msgId }), from: '?', body: '' });
        continue;
      }
      for (const line of n.text.split('\n')) {
        if (!line.startsWith('- ')) continue;
        const mail = foldedLineToMail(line);
        if (mail) mails.push(seat && !mail.to ? { ...mail, to: seat } : mail);
      }
      continue;
    }
    // Any other notice (seat mail without meta · capsule · watch · ceo ingress): one item from its source.
    const ceo = n.source === 'ceo-ingress';
    mails.push({ ...(n.msgId === undefined ? {} : { msgId: n.msgId }), from: n.source ?? 'notice',
      intent: n.mailIntent ?? (ceo ? 'request' : 'info'), ...(ceo ? { originKind: 'human' } : {}),
      ...(n.mailClass === 'P0' && !ceo ? { kind: 'alert' } : {}), replyTo: n.replyTo ?? null, body: n.text });
  }
  return { mails, folded };
}

function logCard(card: BulkTriageCard, log: BulkTriageLog, door: 'bundle' | 'human'): void {
  try {
    log('bulk-card', { door, items: card.received, p0: card.counts.p0, p1: card.counts.p1, p2: card.counts.p2, p3: card.counts.p3,
      noise: card.counts.noise, groups: card.groups, folded: card.folded.reduce((s, r) => s + r.count, 0), lines: card.lines });
  } catch { /* observability is fail-open */ }
}

/** Bundle turn text with the card at its head (≥ 3 notices) — otherwise the text unchanged. */
export function triageBundleText(text: string, notices: readonly NextTuiQueueNoticeEntry[], log: BulkTriageLog = defaultLog): { text: string; card: BulkTriageCard | null } {
  if (notices.length < BULK_TRIAGE_MIN_ITEMS) return { text, card: null };
  const card = buildBulkTriageCard(triageInputOfNotices(notices));
  logCard(card, log, 'bundle');
  return { text: withBulkTriageCard(text, card.text), card };
}

/** A person's text with the card at its head (long, ≥ 3 asks) — the person's text always follows, never dropped. */
export function triageHumanText(text: string, log: BulkTriageLog = defaultLog): { text: string; card: BulkTriageCard | null } {
  if (!humanTextNeedsTriage(text)) return { text, card: null };
  const card = buildBulkTriageCard({ human: { text } });
  logCard(card, log, 'human');
  return { text: withBulkTriageCard(text, card.text), card };
}
