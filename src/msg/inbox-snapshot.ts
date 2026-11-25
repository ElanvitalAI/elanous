// SIGNAL-INBOX-SNAPSHOT (Q6 · OP 11-25 «OP 가 우편함을 폴링» · SIGNAL-SYSTEM-REVIEW 꼴 4 · 안 D)
//
// S: a long-turn OP re-read its mailbox with MsgList every turn — same-args blocks (3×), context growth, and the
//    «unread» answer changed under it while it worked.
// C: seats only (a member chat is unchanged) · structured fields only (refs · sender · kind · crown id) · not an ack.
// Q: what one block lets the seat skip MsgList at turn start and on each goal-drive continuation?
// A: «Inbox (unhandled)» — the seat's unread mail grouped by cause (cell → PR → seat), newest first, one line each
//    (`#id · from · kind · gist`), capped at {@link SNAPSHOT_CAP} lines with «+N more». Lapsed directives show once as
//    «expired: #id»; lapsed passive mail is one «expired n» count. Every listed mail gets a `delivered` receipt
//    (source turn-snapshot) — never `seen`/ack: handling it is still the seat's own act.
//
// 세 얼굴: 관측 = debug.log('msg.snapshot', 'built', {seat, unread, shown, lapsed}) · 판단 근거 = {@link buildInboxSnapshot}
// (pure) · 수복과 인계 = the block rides the turn's volatile tail; a ledger error drops only the block (fail-open).

import { isDirective } from './directive-expiry.js';

export const SNAPSHOT_CAP = 25;
const GIST_MAX = 80;
export const SNAPSHOT_HEADER = '## Inbox (unhandled)';

export interface SnapshotMail {
  readonly id: number;
  readonly from: string;
  readonly kind?: string | null;
  readonly body: string;
  readonly refs?: readonly string[];
  readonly crownDirective?: string | null;
  readonly goal?: string | null;
  readonly priority?: number | null;
}

export type CauseKind = 'cell' | 'pr' | 'seat';
export interface Cause { readonly kind: CauseKind; readonly key: string }

/** The cause a mail belongs to — a `cell:`/`card:` ref, else a `pr:` ref, else its sender seat. Structured refs only. */
export function causeOf(m: SnapshotMail): Cause {
  for (const ref of m.refs ?? []) {
    const cell = /^(?:cell|card):(.+)$/i.exec(ref.trim());
    if (cell) return { kind: 'cell', key: cell[1]!.trim() };
  }
  for (const ref of m.refs ?? []) {
    const pr = /^pr:#?(\d+)$/i.exec(ref.trim());
    if (pr) return { kind: 'pr', key: `#${pr[1]}` };
  }
  return { kind: 'seat', key: m.from.trim().toUpperCase() };
}

/** First nonempty body line, whitespace folded, clipped. Display only — nothing is decided from it. */
export function gistOf(body: string): string {
  const line = body.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).find((l) => l.length > 0) ?? '';
  const chars = Array.from(line);
  return chars.length > GIST_MAX ? `${chars.slice(0, GIST_MAX - 1).join('')}…` : line;
}

const kindOf = (m: SnapshotMail): string => {
  const base = (m.kind ?? '').trim() || 'mail';
  return typeof m.crownDirective === 'string' && m.crownDirective.trim() ? `${base} · crown` : base;
};

export interface SnapshotResult {
  /** The block, or null when there is nothing unread and nothing lapsed. */
  readonly text: string | null;
  /** Ids printed in the block (the ones that get a `delivered` receipt). */
  readonly shownIds: readonly number[];
  /** Lapsed directive ids named in this block (shown once — the caller remembers them). */
  readonly expiredNamed: readonly number[];
}

/**
 * Pure. `unread` = the seat's unread mail (any order) · `lapsed` = mail that expired since the last snapshot and was
 * never acked · `alreadyNamed` = lapsed directive ids an earlier snapshot already showed.
 */
export function buildInboxSnapshot(unread: readonly SnapshotMail[], lapsed: readonly SnapshotMail[] = [],
  alreadyNamed: ReadonlySet<number> = new Set(), cap: number = SNAPSHOT_CAP, outboundLine: string | null = null): SnapshotResult {
  const newest = [...unread].sort((a, b) => b.id - a.id);
  const order: CauseKind[] = ['cell', 'pr', 'seat'];
  const groups = new Map<string, { cause: Cause; mails: SnapshotMail[] }>();
  for (const m of newest) {
    const cause = causeOf(m);
    const key = `${cause.kind}:${cause.key}`;
    const group = groups.get(key) ?? { cause, mails: [] };
    group.mails.push(m);
    groups.set(key, group);
  }
  // Groups: cause kind order, then the group holding the newest mail first.
  const sorted = [...groups.values()].sort((a, b) => order.indexOf(a.cause.kind) - order.indexOf(b.cause.kind) || b.mails[0]!.id - a.mails[0]!.id);
  const lines: string[] = [];
  const shownIds: number[] = [];
  let budget = cap;
  for (const group of sorted) {
    if (budget <= 1) break; // a group heading with no mail under it is noise
    lines.push(`${group.cause.kind} ${group.cause.key}`);
    budget -= 1;
    for (const m of group.mails) {
      if (budget <= 0) break;
      lines.push(`  #${m.id} · ${m.from} · ${kindOf(m)} · ${gistOf(m.body)}`);
      shownIds.push(m.id);
      budget -= 1;
    }
  }
  const more = newest.length - shownIds.length;
  if (more > 0) lines.push(`+${more} more`);
  const lapsedDirectives = lapsed.filter((m) => isDirective({ crownDirective: m.crownDirective ?? null, goal: m.goal ?? null, kind: m.kind ?? null }) && !alreadyNamed.has(m.id))
    .sort((a, b) => b.id - a.id);
  const lapsedPassive = lapsed.filter((m) => !isDirective({ crownDirective: m.crownDirective ?? null, goal: m.goal ?? null, kind: m.kind ?? null })).length;
  for (const m of lapsedDirectives) lines.push(`expired: #${m.id} (${m.from}) — do not act on it`);
  if (lapsedPassive > 0) lines.push(`expired ${lapsedPassive}`);
  if (outboundLine) lines.push(outboundLine);
  if (lines.length === 0) return { text: null, shownIds: [], expiredNamed: [] };
  const head = `${SNAPSHOT_HEADER} — ${newest.length} unread · this block is the whole unhandled list at turn start; no MsgList needed to find it`;
  return { text: [head, ...lines].join('\n'), shownIds, expiredNamed: lapsedDirectives.map((m) => m.id) };
}
