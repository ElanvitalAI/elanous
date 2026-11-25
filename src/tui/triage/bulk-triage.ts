/**
 * BULK-TRIAGE (CEO 11-25) — many messages at once become ONE triage card: aggregate, split, prioritise.
 *
 * S: a seat that receives 10–30 mails in a burst (or a person who pours seven asks into one message) got one long
 *    digest / one long paragraph. The model had to find the crown item, the deadlines and the duplicates itself, and
 *    often answered the first line and dropped the rest.
 * C: «10개 20개가 몰려도 한번에 처리» — one turn, one card: every item accounted for, P0/P1 listed one by one, info and
 *    noise folded to counts, the card never longer than 40 lines.
 * Q: how do we rank without an LLM call and without guessing from the prose?
 * A: from STRUCTURED fields only (crownDirective · origin kind · intent · kind · deadline · priority · replyTo · from/to).
 *    The body only supplies the one-line gist and the thread subject. A person's long text is split on its own list
 *    structure (numbered / bulleted lines · «그리고»), and an explicit crown mark (the crown emoji · [대표] · 긴급 · 최우선 · P0) raises an ask.
 *
 * 세 얼굴:
 *   관측 = the hook logs `triage.bulk-card {items, p0, p1, p2, p3, noise, groups, folded}` per card
 *   인지 = classify → priority → thread fold (replyTo · subject) → budgeted render (P0/P1 always listed)
 *   수복과 인계 = nothing is dropped: every msgId is listed or counted (P3 / noise ids · folded ranges); the card is a
 *                 fixed-id block that replaces itself, and the original text always follows it.
 *
 * Pure module: no queue, no ledger, no log, no clock.
 */

export type TriageClass = 'decision' | 'coordination' | 'action' | 'info' | 'noise';
export type TriagePriority = 'P0' | 'P1' | 'P2' | 'P3' | 'noise';

/** One seat mail as the triage reads it — the structured ledger fields plus the body (gist + subject only). */
export interface BulkTriageMail {
  readonly msgId?: number;
  readonly from: string;
  /** The recipient seat — a mail from a seat to itself is a self-wake (noise). */
  readonly to?: string | null;
  readonly intent?: string | null;
  readonly kind?: string | null;
  readonly crownDirective?: string | null;
  /** `origin.kind` / `fromKind` — `human` is a person. */
  readonly originKind?: string | null;
  readonly replyTo?: number | null;
  readonly deadline?: string | null;
  readonly blocking?: boolean;
  /** Ledger priority: urgent = 2 · p0 = 1 · normal = 0. */
  readonly priority?: number | null;
  readonly body: string;
}

/** A range of mails the queue could not take one by one (`ids #a..#b`) — counted, never lost. */
export interface BulkTriageFoldedRange { readonly first: number; readonly last: number; readonly count: number }

export interface BulkTriageInput {
  readonly mails?: readonly BulkTriageMail[];
  /** One long human text — split into atomic asks. */
  readonly human?: { readonly text: string; readonly from?: string } | null;
  readonly folded?: readonly BulkTriageFoldedRange[];
}

export interface BulkTriageEntry {
  readonly priority: TriagePriority;
  readonly cls: TriageClass;
  readonly from: string;
  readonly gist: string;
  /** The kept item's id first, then the duplicates folded into it. */
  readonly ids: readonly number[];
  readonly duplicates: number;
  readonly source: 'mail' | 'human';
  readonly deadline?: string;
}

export interface BulkTriageCounts { p0: number; p1: number; p2: number; p3: number; noise: number }

export interface BulkTriageCard {
  /** Items received: mails + human asks + folded-range mails. */
  readonly received: number;
  /** Non-noise threads (the «처리 묶음»). */
  readonly groups: number;
  readonly counts: BulkTriageCounts;
  /** P0 → P1 → P2 → P3, arrival order inside a priority (noise not included). */
  readonly entries: readonly BulkTriageEntry[];
  readonly noise: { readonly duplicates: number; readonly selfWakes: number; readonly ids: readonly number[] };
  readonly folded: readonly BulkTriageFoldedRange[];
  /** Every mail id the card lists or counts (folded ranges are reported separately). */
  readonly accountedIds: readonly number[];
  readonly text: string;
  readonly lines: number;
}

/** The fixed block id — feeding a card twice yields one block. */
export const BULK_TRIAGE_ID = 'bulk-triage-card';
export const BULK_TRIAGE_MARK = `<!-- ${BULK_TRIAGE_ID} -->`;
export const BULK_TRIAGE_END = `<!-- /${BULK_TRIAGE_ID} -->`;
/** The card never exceeds this many lines (marks included) — P0/P1 always listed, P2 folds first. */
export const BULK_TRIAGE_MAX_LINES = 40;
/** Hook thresholds: a bundle of ≥ 3 notices, or a human text of ≥ 400 chars carrying ≥ 3 asks. */
export const BULK_TRIAGE_MIN_ITEMS = 3;
export const BULK_TRIAGE_HUMAN_MIN_CHARS = 400;
/** TUI-LONG-PASTE-SPIN — above this many asks a person's text is a document (a pasted report · a table), not a list of
 *  asks: no card. The live OP case was one 48-line pasted report read as 42 «asks». */
export const BULK_TRIAGE_HUMAN_MAX_ASKS = 12;
export const BULK_TRIAGE_RULE_LINE = '처리 규칙: P0·P1 은 이번 턴에 · P3 는 흡수만 · noise 는 읽음 처리';

const GIST_CHARS = 60;
const SUBJECT_CHARS = 60;
const PRIORITY_ORDER: readonly TriagePriority[] = ['P0', 'P1', 'P2', 'P3', 'noise'];
const CLASS_LABEL: Record<TriageClass, string> = { decision: '결정', coordination: '조율', action: '실행', info: '정보', noise: '잡음' };
const WAKE_KINDS = new Set(['wake', 'self-wake', 'nudge', 'wakeup']);
const INFO_KINDS = new Set(['info', 'report', 'ack', 'receipt', 'receipts', 'retro', 'retro-report']);

const norm = (value: string | null | undefined): string => (typeof value === 'string' ? value.trim().toLowerCase() : '');
const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/gu, ' ').trim();
  const chars = Array.from(flat);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : flat;
};
const firstLine = (body: string): string => {
  for (const raw of body.split('\n')) { const line = raw.trim(); if (line) return line; }
  return '';
};

/** Class from structured fields (never the body). */
export function classifyTriageMail(m: BulkTriageMail): Exclude<TriageClass, 'noise'> {
  const intent = norm(m.intent);
  const kind = norm(m.kind);
  if (intent === 'decision' || kind === 'decision' || kind === 'approval') return 'decision';
  if (intent === 'coord' || intent === 'coordination' || kind === 'coord' || kind === 'coordination') return 'coordination';
  if (typeof m.crownDirective === 'string' && m.crownDirective.trim()) return 'action';
  if (norm(m.originKind) === 'human') return 'action';
  if (['request', 'alert'].includes(intent) || ['request', 'alert', 'urgent'].includes(kind)) return 'action';
  if (INFO_KINDS.has(kind) || intent === 'info' || intent === 'report') return 'info';
  return intent || kind ? 'info' : 'action';
}

/** A seat waking itself: from == to, or a wake kind. */
export function isSelfWake(m: BulkTriageMail): boolean {
  if (WAKE_KINDS.has(norm(m.kind)) || WAKE_KINDS.has(norm(m.intent))) return true;
  return !!m.to && norm(m.to) === norm(m.from);
}

/** P0 = human / crown / alert / urgent · P1 = request·decision with a deadline or blocking · P2 = other asks · P3 = info. */
export function priorityOfMail(m: BulkTriageMail, cls: Exclude<TriageClass, 'noise'>): Exclude<TriagePriority, 'noise'> {
  if (typeof m.crownDirective === 'string' && m.crownDirective.trim()) return 'P0';
  if (norm(m.originKind) === 'human') return 'P0';
  if (norm(m.intent) === 'alert' || norm(m.kind) === 'alert' || norm(m.kind) === 'urgent' || (m.priority ?? 0) >= 2) return 'P0';
  if (cls === 'info') return 'P3';
  if ((cls === 'decision' || cls === 'action') && (!!m.deadline?.trim() || m.blocking === true || (m.priority ?? 0) >= 1)) return 'P1';
  return 'P2';
}

/** Thread key: a reply folds onto its question; otherwise the normalised subject (first body line) from the same thread. */
export function threadKeyOf(m: BulkTriageMail): string {
  if (typeof m.replyTo === 'number' && m.replyTo > 0) return `reply:${m.replyTo}`;
  let subject = firstLine(m.body).toLowerCase().replace(/\s+/gu, ' ');
  for (let i = 0; i < 3; i += 1) subject = subject.replace(/^(?:re|fwd?)\s*:\s*/u, '');
  return `subj:${Array.from(subject).slice(0, SUBJECT_CHARS).join('')}`;
}

const LIST_MARK = /^\s*(?:\(?\d{1,2}[.)]|[①-⑳]|[-*•·▪◦]|[ㄱ-ㅎ][.)])\s+/u;
/** TUI-LONG-PASTE-SPIN — a line that is drawing or quoting, never an ask: box-drawing / table rows (│ ├ └ ┌ … ─),
 *  markdown table rows (| … |), quoted lines (> · >>> · a pasted prompt ❯ › $). Judged on the line's first character. */
const NON_ASK_LINE = /^\s*(?:[\u2500-\u257F]|[|❯›>$])/u;
const CROWN_MARK = /\u{1F451}|\[대표\]|긴급|최우선|urgent|\bP0\b|!!/iu;

/**
 * Split one human text into atomic asks — on its own structure: one ask per non-empty line (list markers stripped),
 * and a line joined by «그리고» splits into its parts. A heading line ending with «:» is not an ask.
 */
export function splitHumanAsks(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/u)) {
    if (NON_ASK_LINE.test(raw)) continue;
    const line = raw.replace(LIST_MARK, '').trim();
    if (!line || /[:：]$/u.test(line)) continue;
    for (const part of line.split(/\s*,?\s*그리고\s+/u)) {
      const ask = part.trim().replace(/^[,·]\s*/u, '');
      if (Array.from(ask).length >= 2) out.push(ask);
    }
  }
  return out;
}

export const isCrownFlaggedAsk = (ask: string): boolean => CROWN_MARK.test(ask);

/** Compress ids to `#1-#3,#7` (sorted, unique). */
export function compressIds(ids: readonly number[]): string {
  const sorted = [...new Set(ids)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length;) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j += 1;
    parts.push(j > i ? `#${sorted[i]}-#${sorted[j]}` : `#${sorted[i]}`);
    i = j + 1;
  }
  return parts.join(',');
}

interface Working { priority: Exclude<TriagePriority, 'noise'>; cls: Exclude<TriageClass, 'noise'>; from: string; gist: string; ids: number[]; duplicates: number; source: 'mail' | 'human'; deadline?: string; order: number }

/** Build the card. Deterministic: same input → same bytes. */
export function buildBulkTriageCard(input: BulkTriageInput): BulkTriageCard {
  const mails = input.mails ?? [];
  const folded = (input.folded ?? []).filter((r) => r.count > 0);
  const counts: BulkTriageCounts = { p0: 0, p1: 0, p2: 0, p3: 0, noise: 0 };
  const noiseIds: number[] = [];
  let duplicates = 0;
  let selfWakes = 0;
  const threads = new Map<string, Working>();
  const working: Working[] = [];
  let order = 0;
  const bump = (p: TriagePriority): void => { counts[p === 'noise' ? 'noise' : (p.toLowerCase() as 'p0' | 'p1' | 'p2' | 'p3')] += 1; };
  for (const m of mails) {
    if (isSelfWake(m)) {
      selfWakes += 1; counts.noise += 1;
      if (typeof m.msgId === 'number') noiseIds.push(m.msgId);
      continue;
    }
    const cls = classifyTriageMail(m);
    const priority = priorityOfMail(m, cls);
    const key = threadKeyOf(m);
    const held = threads.get(key);
    if (held) {
      // Duplicate in the same thread: folded into the kept entry; the thread takes the higher priority.
      duplicates += 1; counts.noise += 1; held.duplicates += 1;
      if (typeof m.msgId === 'number') { held.ids.push(m.msgId); noiseIds.push(m.msgId); }
      if (PRIORITY_ORDER.indexOf(priority) < PRIORITY_ORDER.indexOf(held.priority)) {
        counts[held.priority.toLowerCase() as 'p0'] -= 1; bump(priority);
        held.priority = priority; held.cls = cls; held.from = m.from; held.gist = clip(firstLine(m.body), GIST_CHARS);
        if (m.deadline) held.deadline = m.deadline;
      }
      continue;
    }
    const w: Working = { priority, cls, from: m.from, gist: clip(firstLine(m.body), GIST_CHARS) || '(빈 본문)', ids: typeof m.msgId === 'number' ? [m.msgId] : [],
      duplicates: 0, source: 'mail', ...(m.deadline ? { deadline: m.deadline } : {}), order: order++ };
    threads.set(key, w); working.push(w); bump(priority);
  }
  let humanAsks = 0;
  if (input.human && input.human.text.trim()) {
    for (const ask of splitHumanAsks(input.human.text)) {
      humanAsks += 1;
      // TUI-LONG-PASTE-SPIN — a person's line is an ordinary ask (P2) unless it carries an explicit crown mark (P0):
      // P1 means «deadline or blocking», which a free-text line does not state.
      const priority = isCrownFlaggedAsk(ask) ? 'P0' : 'P2';
      working.push({ priority, cls: 'action', from: input.human.from ?? '사람', gist: clip(ask, GIST_CHARS), ids: [], duplicates: 0, source: 'human', order: order++ });
      bump(priority);
    }
  }
  const entries = [...working].sort((a, b) => PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority) || a.order - b.order);
  const foldedCount = folded.reduce((sum, r) => sum + r.count, 0);
  const received = mails.length + humanAsks + foldedCount;
  const accountedIds = mails.flatMap((m) => (typeof m.msgId === 'number' ? [m.msgId] : []));
  const text = renderCard({ received, entries, counts, noise: { duplicates, selfWakes, ids: noiseIds }, folded });
  return {
    received, groups: entries.length, counts,
    entries: entries.map(({ order: _o, ...e }) => e),
    noise: { duplicates, selfWakes, ids: noiseIds }, folded, accountedIds, text, lines: text.split('\n').length,
  };
}

function entryLine(n: number, e: Working): string {
  const who = e.source === 'human' ? `👤 ${e.from}` : e.from;
  const ids = e.ids.length === 0 ? '' : ` · ${e.duplicates > 0 ? `#${e.ids[0]} (중복 ${e.duplicates}: ${compressIds(e.ids.slice(1))})` : `#${e.ids[0]}`}`;
  const due = e.deadline ? ` · 기한 ${e.deadline}` : '';
  return `${n}. [${e.priority}] ${CLASS_LABEL[e.cls]} · ${who} · ${e.gist}${due}${ids}`;
}

function renderCard(c: { received: number; entries: Working[]; counts: BulkTriageCounts; noise: { duplicates: number; selfWakes: number; ids: number[] }; folded: readonly BulkTriageFoldedRange[] }): string {
  const header = `📋 받은 것 ${c.received} → 처리 묶음 ${c.entries.length} (P0 ${c.counts.p0} · P1 ${c.counts.p1} · P2 ${c.counts.p2} · P3 ${c.counts.p3} · noise ${c.counts.noise})`;
  const must = c.entries.filter((e) => e.priority === 'P0' || e.priority === 'P1');
  const p2 = c.entries.filter((e) => e.priority === 'P2');
  const p3 = c.entries.filter((e) => e.priority === 'P3');
  const tail: string[] = [];
  if (p3.length > 0) {
    const bySender = new Map<string, number>();
    for (const e of p3) bySender.set(e.from, (bySender.get(e.from) ?? 0) + 1);
    const senders = [...bySender].map(([from, n]) => `${from} ${n}`).join(' · ');
    const ids = p3.flatMap((e) => e.ids.slice(0, 1));
    tail.push(`[P3] 정보 ${p3.length}건 · 흡수만 · ${senders}${ids.length ? ` · ${compressIds(ids)}` : ''}`);
  }
  if (c.counts.noise > 0) {
    tail.push(`[noise] ${c.counts.noise}건 · 읽음 처리 · 중복 ${c.noise.duplicates} · 자기 깨움 ${c.noise.selfWakes}${c.noise.ids.length ? ` · ${compressIds(c.noise.ids)}` : ''}`);
  }
  for (const r of c.folded) tail.push(`[접힘] #${r.first}..#${r.last} ${r.count}건 · 아직 큐 밖 — 이 턴 끝에 eln msg list 로 이어 읽기`);
  const lines = [BULK_TRIAGE_MARK, header];
  let n = 0;
  // TUI-LONG-PASTE-SPIN — the 40-line cap is absolute (the live card had 46: 41 «always listed» P1). Every priority
  // lists while it fits and folds the rest into ONE count line with its ids; P0 first, then P1, then P2.
  // Fixed lines: the two marks · header · rule · the tail (P3 · noise · folded ranges) — the tail is clipped too.
  const fixedTail = tail.slice(0, Math.max(0, BULK_TRIAGE_MAX_LINES - 4 - 3));
  let room = BULK_TRIAGE_MAX_LINES - lines.length - fixedTail.length - 2; // − rule − end mark
  const groups = ([['P0', must.filter((e) => e.priority === 'P0')], ['P1', must.filter((e) => e.priority === 'P1')], ['P2', p2]] as const)
    .filter(([, group]) => group.length > 0);
  groups.forEach(([label, group], at) => {
    // Every later group keeps at least its one count line, so no priority is ever left out of the card.
    const budget = Math.max(0, room - (groups.length - at - 1));
    const listed = group.length <= budget ? group : group.slice(0, Math.max(0, budget - 1));
    for (const e of listed) lines.push(entryLine(++n, e));
    room -= listed.length;
    const rest = group.slice(listed.length);
    if (rest.length > 0) {
      const ids = rest.flatMap((e) => e.ids);
      lines.push(`[${label}] +${rest.length}건 더${ids.length ? ` · ${compressIds(ids)}` : ''}`);
      room -= 1;
    }
  });
  lines.push(...fixedTail, BULK_TRIAGE_RULE_LINE, BULK_TRIAGE_END);
  return lines.join('\n');
}

/** Put the card at the head of the turn text: an earlier card (same fixed id) is replaced, never stacked. The original text always follows. */
export function withBulkTriageCard(text: string, card: string | null): string {
  let rest = text;
  for (;;) {
    const at = rest.indexOf(BULK_TRIAGE_MARK);
    if (at < 0) break;
    const end = rest.indexOf(BULK_TRIAGE_END, at);
    const cut = end < 0 ? at + BULK_TRIAGE_MARK.length : end + BULK_TRIAGE_END.length;
    rest = `${rest.slice(0, at)}${rest.slice(cut)}`.replace(/^\s+/u, '');
  }
  return card ? `${card}\n\n${rest}` : rest;
}

/** Hook gate for a person's text: long enough and carrying enough asks. */
export function humanTextNeedsTriage(text: string): boolean {
  if (Array.from(text).length < BULK_TRIAGE_HUMAN_MIN_CHARS) return false;
  const asks = splitHumanAsks(text).length;
  return asks >= BULK_TRIAGE_MIN_ITEMS && asks <= BULK_TRIAGE_HUMAN_MAX_ASKS;
}
