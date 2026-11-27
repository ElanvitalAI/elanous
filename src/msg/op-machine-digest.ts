// ── SIGNAL-DIET-OP-DIGEST (0.3.38 P0 · CEO «land 10/h · OP must think deeper, not drown») ──────────────────────────
//
// S: measured 11-27 07:43 — OP received 83 mails in 45 min and 53 % were machine mail (LAND-GRAPH 26 · ORCHESTRATOR/행정관
//    14 · JUDGE-BUTLER · GUARDIAN). Every row is a wake and a re-read; the judgement turns drowned in status cards.
// C: humans, sub-coordinators and 대표 stay direct · nothing is dropped · 🚨 (main broken · release blocked · security / cost
//    incident · P0 · crown) never waits · machine producers keep calling `store.post` / `appendWithProvenance` unchanged.
// Q: how does OP hear the machines once per half hour instead of one row per tick?
// A: at the store's write door a machine sender's mail to OP is parked in `msg_op_digest_pending` (same transaction);
//    when the oldest parked item is {@link OP_DIGEST_WINDOW_MS} old, the next OP-bound write flushes them as ONE mail
//    from {@link OP_DIGEST_SENDER}: counts per sender ⊕ the top {@link OP_DIGEST_TOP} items needing a decision.
//
// 세 얼굴: 관측 = debug.log('msg.op-digest', 'parked' | 'flushed') ⊕ `msg_op_digest_pending.flushed_into` ·
// 판단 근거 = {@link opDigestFolds} (structured sender ⊕ 🚨 pass-through) · 수복과 인계 = every parked body stays in
// the pending table (flushed_into = the digest row id); a provenance key maps to the digest row, so retries stay idempotent.

import { MAIL_ROUTE_POLICY_DEFAULTS, mailBypassesWindow } from '../kit/mail-route/policy.js';

/** One digest per half hour (CEO «one 30-min digest mail») — the default of the shared mail-route policy; the store reads
 *  the policy in force (`readMailRoutePolicy().windowMs`) at flush time. */
export const OP_DIGEST_WINDOW_MS = MAIL_ROUTE_POLICY_DEFAULTS.windowMs;
/** Items needing a decision quoted in the digest (CEO «counts + top 3»). */
export const OP_DIGEST_TOP = 3;
export const OP_DIGEST_SENDER = 'SIGNAL-DIGEST';
export const OP_DIGEST_RECIPIENT = 'OP';
const LINE_MAX = 200;

/** DORMANT-ADDRESS REROUTE (dormant-reroute.ts) — the ref a rerouted row carries: `rerouted-from:<address>`. */
export const REROUTED_FROM_REF = 'rerouted-from:';
/** The dormant address a row was rerouted from (null = not rerouted). */
export function reroutedFrom(refs: readonly string[] | null | undefined): string | null {
  const r = (refs ?? []).find((x) => x.startsWith(REROUTED_FROM_REF));
  return r ? r.slice(REROUTED_FROM_REF.length) : null;
}

/** Machine senders (canonical addresses). Rail-watch is NOT here: a rail regression card means main is broken (🚨). */
export const OP_MACHINE_SENDERS: ReadonlySet<string> = new Set([
  'LAND-GRAPH', 'ORCHESTRATOR', 'JUDGE-BUTLER', 'GUARDIAN', 'BOARD-STEWARD', 'HOLD-LEDGER', 'SUPERVISOR-JOURNAL',
]);

/** SUPERVISOR-CORRECTION-JOURNAL — the rollup sender (src/loop-agent/journal.ts JOURNAL_SENDER): one line per supervisor per
 *  window that acted or failed. The digest quotes each line (not only a count) — that line IS the status. */
export const JOURNAL_ROLLUP_SENDER = 'SUPERVISOR-JOURNAL';

/** Kinds / ref prefixes that mark 🚨 — main broken · release blocked · security or cost incident. */
const URGENT_KINDS: ReadonlySet<string> = new Set(['main-broken', 'release-blocked', 'release-block', 'security', 'security-incident', 'cost-incident']);
const URGENT_REF_PREFIXES = ['main-broken', 'release-blocked', 'release-block', 'security', 'cost-incident', 'incident:security', 'incident:cost'] as const;

export interface DigestCandidate {
  readonly from: string;
  readonly to: string;
  readonly body: string;
  readonly kind?: string | null;
  readonly intent?: string | null;
  readonly priority?: number | null;
  readonly crownDirective?: string | null;
  readonly refs?: readonly string[] | null;
  readonly replyTo?: number | null;
  readonly goal?: string | null;
}

/** Is `sender` (canonical) a machine/loop sender? Listed names ⊕ any `*-STEWARD` / `*-BUTLER` loop agent. */
export function isMachineSender(sender: string): boolean {
  const s = sender.trim().toUpperCase();
  return OP_MACHINE_SENDERS.has(s) || s.endsWith('-STEWARD') || s.endsWith('-BUTLER');
}

/** 🚨 — passes through the digest straight to OP. */
export function opDigestUrgent(m: DigestCandidate): boolean {
  // KIT mail-route P0 rule (crown · goal · priority ≥ 1 · 🚨 · prio:P0/urgent ref) ⊕ the machine-digest kinds/refs below.
  if (mailBypassesWindow(m)) return true;
  if (URGENT_KINDS.has((m.kind ?? '').trim().toLowerCase())) return true;
  return (m.refs ?? []).some((r) => { const v = r.trim().toLowerCase(); return URGENT_REF_PREFIXES.some((p) => v === p || v.startsWith(`${p}:`)); });
}

/** Does this mail wait for the OP digest instead of landing in OP's inbox? */
export function opDigestFolds(m: DigestCandidate): boolean {
  if (m.to !== OP_DIGEST_RECIPIENT) return false;
  if (!isMachineSender(m.from) && reroutedFrom(m.refs) === null) return false;
  if (typeof m.replyTo === 'number') return false; // a reply to OP's own ask is an answer, not noise
  return !opDigestUrgent(m);
}

export interface ParkedItem {
  readonly id: number;
  readonly sender: string;
  readonly kind: string | null;
  readonly intent: string | null;
  readonly body: string;
  readonly refs: readonly string[];
  readonly createdAt: string;
}

/** Needs OP's decision: a decision/request ask or a steward exception card. */
export function needsDecision(i: Pick<ParkedItem, 'kind' | 'intent'>): boolean {
  const kind = (i.kind ?? '').toLowerCase();
  return i.intent === 'decision' || kind === 'request' || kind === 'decision' || kind === 'steward-exception';
}

const oneLine = (s: string): string => { const t = s.replace(/\s+/gu, ' ').trim(); return t.length > LINE_MAX ? `${t.slice(0, LINE_MAX - 1)}…` : t; };
const hhmm = (iso: string): string => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '--:--' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

/** Pure: the digest body. Counts per sender (most first) ⊕ top {@link OP_DIGEST_TOP} decision items (newest first). */
export function renderOpDigest(items: readonly ParkedItem[]): string {
  const bySender = new Map<string, number>();
  for (const i of items) bySender.set(i.sender, (bySender.get(i.sender) ?? 0) + 1);
  const counts = [...bySender.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([s, n]) => `${s} ${n}`).join(' · ');
  const decisions = items.filter(needsDecision);
  const top = decisions.slice().sort((a, b) => b.id - a.id).slice(0, OP_DIGEST_TOP);
  const first = items.reduce((m, i) => (i.createdAt < m ? i.createdAt : m), items[0]?.createdAt ?? '');
  const last = items.reduce((m, i) => (i.createdAt > m ? i.createdAt : m), '');
  const dormant = items.filter((i) => reroutedFrom(i.refs) !== null);
  const byDormant = new Map<string, number>();
  for (const i of dormant) { const a = reroutedFrom(i.refs)!; byDormant.set(a, (byDormant.get(a) ?? 0) + 1); }
  const dormantLines = dormant.length ? [
    `잠든 수신처 (no live tab · ${dormant.length}): ${[...byDormant.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([a, n]) => `${a} ${n}`).join(' · ')}`,
    ...dormant.slice().sort((a, b) => b.id - a.id).slice(0, OP_DIGEST_TOP).map((i) => `  - ${i.sender} → ${reroutedFrom(i.refs)}: ${oneLine(i.body.replace(/^\[rerouted from [^\]]*\] /u, ''))}`),
  ] : [];
  const journal = items.filter((i) => i.sender === JOURNAL_ROLLUP_SENDER).sort((a, b) => a.id - b.id);
  const journalLines = journal.length ? [`Supervisor corrections (${journal.length}):`, ...journal.map((i) => `  - ${oneLine(i.body)}`)] : [];
  const lines = [
    `[machine digest · ${items.length} mails ${hhmm(first)}–${hhmm(last)} · needs decision ${decisions.length}] ${counts}`,
    ...(top.length ? ['Needs your decision:', ...top.map((i, n) => `  ${n + 1}. ${i.sender}${i.kind ? `/${i.kind}` : ''} — ${oneLine(i.body)}`)] : ['No item needs a decision — status only.']),
    ...(decisions.length > top.length ? [`  … ${decisions.length - top.length} more decision items`] : []),
    ...dormantLines,
    ...journalLines,
    'Bodies are kept in the msg ledger (msg_op_digest_pending · flushed_into = this mail) · 🚨 mail never waits for this digest.',
  ];
  return lines.join('\n');
}
