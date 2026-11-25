// MSG-CLEAR (CEO 11-25 21:5x «메시지 치우는 CLI 장치» — 184 escalation mails flooded OP) — bulk-ack a seat's unread inbox by
// filters. Never deletes: every cleared id becomes a per-id ack row (cursor untouched), and every apply writes a receipt
// so `--undo <receipt>` removes exactly those ack rows again.
// Protected (skipped unless --include-protected): crown-directive mails · alert mails (kind or intent) · original ✋
// NEED HUMAN mails. An escalated ✋ copy (`hand-escalated-from:` ref, intent decision) is NOT protected — that copy is the flood.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { canonicalMessageAddress, type Message, type MsgStore } from './msg-store.js';
import { isHandRaiseMail } from './hand-raise-ladder.js';

export interface ClearFilters {
  to: string;
  from?: string;
  kind?: string;
  match?: string;
  ref?: string;
  since?: string;
  until?: string;
  olderThanMs?: number;
  ids?: number[];
  includeProtected?: boolean;
}

export interface ClearGroup { from: string; kind: string; head: string; count: number }
export interface ClearPlan { to: string; selected: Message[]; protectedSkipped: Message[]; groups: ClearGroup[] }
export interface ClearReceipt {
  version: 1; to: string; by: string; at: string; filters: ClearFilters; ids: number[];
  protectedIncluded: number[]; mode: 'ack' | 'fold-into-card'; cardId?: number; noticeId?: number;
}

export const CLEAR_PAGE = 1000;
export const CLEAR_MAX = 20_000;

export function isProtectedMail(m: Message): boolean {
  if (m.crownDirective) return true;
  if (m.kind === 'alert' || m.intent === 'alert') return true;
  if (isHandRaiseMail(m) && !(m.refs ?? []).some(r => r.startsWith('hand-escalated-from:'))) return true;
  return false;
}

/** `2h` · `30m` · `90s` · `1d` → ms. */
export function parseAge(raw: string): number {
  const m = /^(\d+)\s*([smhd])$/.exec(raw.trim());
  if (!m) throw new Error(`--older-than expects <n>s|m|h|d, got «${raw}»`);
  return Number(m[1]) * { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 's' | 'm' | 'h' | 'd'];
}

/** A bound is a message id (all digits) or a time (ISO / Date-parsable). */
function bound(raw: string, m: Message): number {
  if (/^\d+$/.test(raw.trim())) return m.id - Number(raw);
  const t = Date.parse(raw);
  if (Number.isNaN(t)) throw new Error(`--since/--until expects a message id or a time, got «${raw}»`);
  return Date.parse(m.createdAt) - t;
}

export function headOf(body: string, n = 40): string { return body.replace(/\s+/g, ' ').trim().slice(0, n); }

export function unreadOf(store: MsgStore, to: string): Message[] {
  const all: Message[] = [];
  let after = store.getCursor(to);
  for (;;) {
    const page = store.listByRecipient(to, after, CLEAR_PAGE);
    // Only direct mail is per-id acked here; ALL/group rows are someone else's broadcast and stay as they are.
    all.push(...page.filter(m => canonicalMessageAddress(m.to) === to));
    if (page.length < CLEAR_PAGE || all.length >= CLEAR_MAX) return all;
    after = page.at(-1)!.id;
  }
}

export function planClear(store: MsgStore, filters: ClearFilters, now: Date): ClearPlan {
  const to = canonicalMessageAddress(filters.to);
  const re = filters.match ? new RegExp(filters.match) : null;
  const from = filters.from ? canonicalMessageAddress(filters.from) : null;
  const idSet = filters.ids ? new Set(filters.ids) : null;
  const selected: Message[] = [];
  const protectedSkipped: Message[] = [];
  for (const m of unreadOf(store, to)) {
    if (from && canonicalMessageAddress(m.from) !== from) continue;
    if (filters.kind && m.kind !== filters.kind && m.intent !== filters.kind) continue;
    if (re && !re.test(headOf(m.body, 200))) continue;
    if (filters.ref && !(m.refs ?? []).some(r => r.includes(filters.ref!))) continue;
    if (filters.since && bound(filters.since, m) < 0) continue;
    if (filters.until && bound(filters.until, m) > 0) continue;
    if (filters.olderThanMs !== undefined && now.getTime() - Date.parse(m.createdAt) < filters.olderThanMs) continue;
    if (idSet && !idSet.has(m.id)) continue;
    if (isProtectedMail(m) && !filters.includeProtected) { protectedSkipped.push(m); continue; }
    selected.push(m);
  }
  const byKey = new Map<string, ClearGroup>();
  for (const m of selected) {
    const g = { from: m.from, kind: m.kind ?? m.intent ?? '-', head: headOf(m.body) };
    const key = `${g.from}\u0000${g.kind}\u0000${g.head}`;
    const hit = byKey.get(key);
    if (hit) hit.count++; else byKey.set(key, { ...g, count: 1 });
  }
  const groups = [...byKey.values()].sort((a, b) => b.count - a.count);
  return { to, selected, protectedSkipped, groups };
}

export function clearReceiptDir(store: MsgStore): string { return join(dirname(store.db.filename), 'clear-receipts'); }

export function filterLine(f: ClearFilters): string {
  const parts: string[] = [];
  if (f.from) parts.push(`from=${f.from}`);
  if (f.kind) parts.push(`kind=${f.kind}`);
  if (f.match) parts.push(`match=/${f.match}/`);
  if (f.ref) parts.push(`ref~${f.ref}`);
  if (f.since) parts.push(`since=${f.since}`);
  if (f.until) parts.push(`until=${f.until}`);
  if (f.olderThanMs !== undefined) parts.push(`older-than=${Math.round(f.olderThanMs / 60_000)}m`);
  if (f.ids) parts.push(`ids-file(${f.ids.length})`);
  if (f.includeProtected) parts.push('INCLUDE-PROTECTED');
  return parts.length ? parts.join(' ') : 'all-unprotected';
}

/** Apply: per-id ack in one transaction, optional summary card first, receipt file, one info notice to the seat. */
export function applyClear(store: MsgStore, plan: ClearPlan, input: { filters: ClearFilters; by: string; now: Date; foldIntoCard?: boolean }): { receiptPath: string; receipt: ClearReceipt } {
  const ids = plan.selected.map(m => m.id);
  const dir = clearReceiptDir(store);
  mkdirSync(dir, { recursive: true });
  const stamp = input.now.toISOString().replace(/[:.]/g, '-');
  const receiptPath = join(dir, `clear-${plan.to}-${stamp}.json`);
  let cardId: number | undefined;
  if (input.foldIntoCard && ids.length) {
    const lines = plan.groups.slice(0, 10).map(g => `· ${g.count}× ${g.from}/${g.kind} «${g.head}»`);
    cardId = store.post({ from: input.by, to: plan.to, kind: 'info', intent: 'info', refs: ['msg-clear:card', `msg-clear-receipt:${receiptPath}`],
      body: `[msg clear · folded ${ids.length} mails into this card]\n${lines.join('\n')}${plan.groups.length > 10 ? `\n· … ${plan.groups.length - 10} more groups` : ''}` }, { dedupe: false }).id;
  }
  if (ids.length) store.ackMessages(plan.to, ids);
  const notice = store.post({ from: input.by, to: plan.to, kind: 'info', intent: 'info', refs: ['msg-clear:notice', `msg-clear-receipt:${receiptPath}`],
    body: `[cleared ${ids.length} mails · ${filterLine(input.filters)} · receipt ${receiptPath}]` }, { dedupe: false });
  const receipt: ClearReceipt = {
    version: 1, to: plan.to, by: input.by, at: input.now.toISOString(), filters: input.filters, ids,
    protectedIncluded: plan.selected.filter(isProtectedMail).map(m => m.id),
    mode: input.foldIntoCard ? 'fold-into-card' : 'ack', ...(cardId ? { cardId } : {}), noticeId: notice.id,
  };
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  return { receiptPath, receipt };
}

/** Undo: remove exactly the receipt's per-id ack rows. A row the cursor has since moved past stays read (reported). */
export function undoClear(store: MsgStore, receiptPath: string): { restored: number; belowCursor: number; receipt: ClearReceipt } {
  if (!existsSync(receiptPath)) throw new Error(`receipt not found: ${receiptPath}`);
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as ClearReceipt;
  if (receipt.version !== 1 || !Array.isArray(receipt.ids)) throw new Error(`not a msg clear receipt: ${receiptPath}`);
  const cursor = store.getCursor(receipt.to);
  const del = store.db.query('DELETE FROM msg_message_acks WHERE message_id = ? AND recipient = ?');
  const restored = store.db.transaction(() => receipt.ids.reduce((n, id) => n + del.run(id, receipt.to).changes, 0)).immediate();
  return { restored, belowCursor: receipt.ids.filter(id => id <= cursor).length, receipt };
}
