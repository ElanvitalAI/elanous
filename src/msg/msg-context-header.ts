// ── SEAT-INBOX B1-C §5d — 모델 맥락 머리줄 «[from <자리> · <intent>]» ──
//
// 자리 우편·에이전트 메시지가 모델 맥락에 들어갈 때 메시지마다 한 줄을 앞에 붙인다. 모델이 에이전트 지시를
// 사람 지시로 착각하지 않게 하려는 줄이다. 사람 발화(from.kind = human)엔 붙이지 않는다.
// 근거는 구조 칸뿐이다: from.kind · from.seat · intent · crown 표식(B1-A 열). 그 열이 아직 없으면 옛 칸
// (sender · kind)으로 내려앉는다. 본문 문장에서 출처를 추측하는 길은 없다(A205 · R-SIG).

// msg-store 를 값으로 싣지 않는다 — TUI 부트가 이 파일을 싣는 동안 bun:sqlite 를 끌어오지 않게(seat-mail-boot 의 지연 require 와 같은 결).
import { legacyIntent } from './msg-receipts.js';
import type { MessageOrigin } from './msg-store.js';

export type MessageFromKind = 'human' | 'agent' | 'system' | 'tool';

export interface ContextHeaderInput {
  /** Legacy sender column (`msg_messages.sender`) — the fallback for `fromSeat`. */
  sender: string;
  /** Legacy transport kind — the fallback for `intent` (§1b mapping). */
  kind?: string | null;
  /** B1-A `from_kind` column, when present. */
  fromKind?: MessageFromKind | null;
  /** B1-A structured `from.seat`, when present. */
  fromSeat?: string | null;
  /** B1-A `intent` column, when present. */
  intent?: string | null;
  /** B1-A `crown_directive` column — only a verified directive id marks the header «crown» (§5c). */
  crownDirective?: string | null;
}

/**
 * §1b «옛 행» rule for `from.kind`: a seat-shaped sender (every SEAT_ALIASES entry and registry seat has this shape —
 * `canonicalSeatId`) is an agent; anything else is system. Human input never arrives through the mail ledger, so
 * mail never falls back to `human`. B1-B integration point: the registry v2 may later mark system seats.
 */
export function legacyFromKind(sender: string): MessageFromKind {
  return /^[A-Z][A-Z0-9_-]{0,63}$/.test(sender.trim()) ? 'agent' : 'system';
}

/** The B1-A structured fields a stored message carries (`origin` · `intent` · `crown_directive` columns). */
export interface StructuredMessageFields {
  origin?: Pick<MessageOrigin, 'kind' | 'seat'>;
  intent?: string | null;
  crownDirective?: string | null;
}

/**
 * B1-A columns → header input. Read paths fill `origin` for every known sender, so the legacy `sender`/`kind`
 * fallback in `modelContextHeader` only covers rows and callers that predate the columns.
 */
export function headerFieldsOf(message: StructuredMessageFields): Partial<ContextHeaderInput> {
  return {
    ...(message.origin === undefined ? {} : { fromKind: message.origin.kind, ...(message.origin.seat ? { fromSeat: message.origin.seat } : {}) }),
    ...(message.intent ? { intent: message.intent } : {}),
    ...(message.crownDirective ? { crownDirective: message.crownDirective } : {}),
  };
}

/** One header line, or null for human input. */
export function modelContextHeader(input: ContextHeaderInput): string | null {
  const fromKind = input.fromKind ?? legacyFromKind(input.sender);
  if (fromKind === 'human') return null;
  const seat = (input.fromSeat ?? input.sender).trim();
  const intent = input.intent ?? legacyIntent(input.kind);
  return `[from ${seat} · ${intent}${input.crownDirective ? ' · crown' : ''}]`;
}

/** Header line ⊕ `msg:<id>` ⊕ the full body (never truncated — #38057 mustFix ①). */
export function seatMessageContextBlock(message: ContextHeaderInput & { id: number; body: string }): string {
  const header = modelContextHeader(message);
  const body = `msg:${message.id} · ${message.body}`;
  return header === null ? body : `${header}\n${body}`;
}
