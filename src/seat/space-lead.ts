// SPACE LEAD KIND (대표 11-25 15:0x [A②] «스페이스 리더 사람 지정: 대표 먼저 — MK 사람 리더 모드 · 예외 카드 텔레그램»).
//
// S: every space lead was an LLM tab; MK is led by the CEO in person, yet a ✋ to MK climbed the ladder on a 10-minute
//    timer as if a tab had ignored it, and the CEO saw it only as a generic card two levels up.
// C: a human answers on their channel, slower than a tab, and their answer must land on the same ledgers as a tab's.
// Q: how does a space say «my lead is a person», and how do that person's taps become the ladder's outcome?
// A: federation.yaml `spaces.<name>.lead: { kind: llm | human, who, escalateAfterMin }` (⊕ the built-in MK→CEO entry),
//    all behind one switch `federation.humanLead.enabled` (default off). For a human-led space:
//      - each ✋ held by its coordinator (and each 행정관 exception card) becomes ONE decision card (decision ledger ·
//        ref `hand-lead:<msgId>`) with buttons resolve / reject / escalate — the existing Telegram / PWA card path;
//      - the escalation timer is the lead's (60 min default) instead of 10 min;
//      - the decided card is executed by the stateless sweep (the 행정관 path) as that ✋'s outcome via applyHandOutcome —
//        exactly once (the ladder's provenance keys), recorded in the decision ledger and the mail ledger.
//
// 세 얼굴: 관측 = needhuman.human-lead-card / .human-lead-applied / .human-lead-failed · `eln seat lead` · 판단 근거 = the card's
// SCQA (who is blocked, on what) · 수복과 인계 = no tap in 60 min → the ordinary ladder climbs (HQ → CEO card).

import type { DecisionOption, RaiseInput } from '../decisions/decision-ledger.js';
import type { HandAction } from '../msg/hand-raise-ladder.js';

export const HUMAN_LEAD_ESCALATE_AFTER_MIN = 60;
export const HUMAN_LEAD_REF_PREFIX = 'hand-lead:';

export type SpaceLeadDecl = { readonly kind: 'llm' } | { readonly kind: 'human'; readonly who: string; readonly escalateAfterMin?: number };

export interface HumanLead {
  /** The space coordinator seat whose ✋ mails the person answers. */
  readonly coordinator: string;
  readonly who: string;
  readonly escalateAfterMs: number;
}

/** Built in, still off until `federation.humanLead.enabled` is true: the MK space is led by the CEO in person. */
export const BUILTIN_HUMAN_LEADS: Readonly<Record<string, { readonly who: string }>> = { MK: { who: 'CEO' } };

/** Validate one `lead:` value of federation.yaml. Returns the lead or an English error. */
export function parseSpaceLead(value: unknown, where: string): { lead?: SpaceLeadDecl; error?: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: `${where}.lead must be an object` };
  const row = value as Record<string, unknown>;
  const extra = Object.keys(row).filter((k) => !['kind', 'who', 'escalateAfterMin'].includes(k));
  if (extra.length) return { error: `${where}.lead has unknown key ${extra[0]}` };
  if (row.kind === 'llm') return { lead: { kind: 'llm' } };
  if (row.kind !== 'human') return { error: `${where}.lead.kind must be llm or human` };
  if (typeof row.who !== 'string' || !row.who.trim()) return { error: `${where}.lead.who must name the person` };
  if (row.escalateAfterMin !== undefined && (typeof row.escalateAfterMin !== 'number' || !Number.isFinite(row.escalateAfterMin) || row.escalateAfterMin < 1 || row.escalateAfterMin > 1440))
    return { error: `${where}.lead.escalateAfterMin must be 1..1440` };
  return { lead: { kind: 'human', who: row.who.trim(), ...(typeof row.escalateAfterMin === 'number' ? { escalateAfterMin: row.escalateAfterMin } : {}) } };
}

export interface HumanLeadConfig {
  readonly enabled?: unknown;
  readonly escalateAfterMin?: unknown;
  /** Per coordinator seat: `{ who, escalateAfterMin }`, or false to drop a built-in entry. */
  readonly spaces?: unknown;
}

/**
 * The live human leads, keyed by coordinator seat. Off (empty) unless `config.enabled === true`.
 * Order: built-in entries ← config `spaces` ← federation.yaml `lead:` (a declared `kind: llm` removes the entry).
 */
export function resolveHumanLeads(input: { config?: HumanLeadConfig | null; declared?: readonly { coordinator: string; lead?: SpaceLeadDecl }[] }): Map<string, HumanLead> {
  const out = new Map<string, HumanLead>();
  const cfg = input.config ?? {};
  if (cfg.enabled !== true) return out;
  const defMin = typeof cfg.escalateAfterMin === 'number' && cfg.escalateAfterMin >= 1 ? cfg.escalateAfterMin : HUMAN_LEAD_ESCALATE_AFTER_MIN;
  const put = (coordinator: string, who: string, min?: number): void => {
    const seat = coordinator.trim().toUpperCase();
    if (seat) out.set(seat, { coordinator: seat, who, escalateAfterMs: Math.round((min ?? defMin) * 60_000) });
  };
  for (const [seat, lead] of Object.entries(BUILTIN_HUMAN_LEADS)) put(seat, lead.who);
  if (cfg.spaces && typeof cfg.spaces === 'object' && !Array.isArray(cfg.spaces)) {
    for (const [seat, raw] of Object.entries(cfg.spaces as Record<string, unknown>)) {
      if (raw === false) { out.delete(seat.trim().toUpperCase()); continue; }
      if (!raw || typeof raw !== 'object') continue;
      const row = raw as { who?: unknown; escalateAfterMin?: unknown };
      put(seat, typeof row.who === 'string' && row.who.trim() ? row.who.trim() : 'CEO', typeof row.escalateAfterMin === 'number' && row.escalateAfterMin >= 1 ? row.escalateAfterMin : undefined);
    }
  }
  for (const space of input.declared ?? []) {
    if (!space.lead) continue;
    if (space.lead.kind === 'llm') out.delete(space.coordinator.trim().toUpperCase());
    else put(space.coordinator, space.lead.who, space.lead.escalateAfterMin);
  }
  return out;
}

// ── the card ──────────────────────────────────────────────────────────────────────────────────

/** Decision option keys are single letters: r = resolve · x = reject · e = escalate. */
export const HUMAN_LEAD_OPTIONS: readonly DecisionOption[] = [
  { key: 'r', label: 'Resolve', consequence: 'the blocked seat continues with your answer' },
  { key: 'x', label: 'Reject', consequence: 'the request is declined and the seat is told why' },
  { key: 'e', label: 'Escalate', consequence: 'it goes up to the HQ coordinator' },
];
const CHOICE_ACTION: Readonly<Record<string, HandAction>> = { r: 'resolve', x: 'reject', e: 'escalate', resolve: 'resolve', reject: 'reject', escalate: 'escalate' };

export function humanLeadAction(choice: string | undefined): HandAction | undefined {
  return choice ? CHOICE_ACTION[choice.trim().toLowerCase()] : undefined;
}

export const humanLeadRef = (msgId: number): string => `${HUMAN_LEAD_REF_PREFIX}${msgId}`;

export function humanLeadMsgId(refs: readonly string[] | undefined): number | undefined {
  const ref = refs?.find((r) => r.startsWith(HUMAN_LEAD_REF_PREFIX));
  const id = ref ? Number(ref.slice(HUMAN_LEAD_REF_PREFIX.length)) : NaN;
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

const line = (text: string, max: number): string => { const t = text.replace(/\s+/g, ' ').trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };

/** The decision card for one ✋ held by a human-led space (or one 행정관 exception, with its own ref). */
export function humanLeadCard(input: { lead: HumanLead; msgId: number; blockedSeat: string; reason: string; body: string; ref?: string }): RaiseInput {
  const minutes = Math.round(input.lead.escalateAfterMs / 60_000);
  return {
    title: line(`[✋ ${input.lead.coordinator} · ${input.blockedSeat}] ${input.body}`, 140),
    category: 'scope',
    scqa: {
      s: line(`${input.blockedSeat} is blocked (${input.reason}) and asked the ${input.lead.coordinator} space`, 230),
      c: line(`You lead the ${input.lead.coordinator} space in person; without an answer in ${minutes} min it climbs to the HQ coordinator`, 230),
    },
    options: [...HUMAN_LEAD_OPTIONS],
    recommendation: { skipped: true, reason: 'a person leads this space' },
    raisedBy: { agent: `steward:${input.lead.coordinator}` },
    refs: [input.ref ?? humanLeadRef(input.msgId), `seat:${input.blockedSeat}`],
    pendingQuestion: line(`Why: ${input.body}`, 500) + `\nWhat changes: Resolve lets ${input.blockedSeat} continue\nDefault: after ${minutes} min it goes to the HQ coordinator`,
  };
}

/** The outcome text the ladder records for a decided card. */
export function humanLeadOutcomeText(input: { who: string; action: HandAction; note?: string; via?: string; decisionId: string }): string {
  const note = input.note?.trim();
  return `${note ? `${note} — ` : ''}${input.who} chose ${input.action}${input.via ? ` via ${input.via}` : ''} (decision ${input.decisionId})`;
}
