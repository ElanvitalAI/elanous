// NEED-HUMAN-PUSH (대표 11-24 16:5x/17:0x): when the TUI publishes the needs-person block it also pushes ONE structured mail up the
// escalation ladder  seat → its space coordinator → OP → CEO (decision card). Push, not polling.
//   • one mail per blockId (the same block re-rendered never re-posts)
//   • no reply in ESCALATE_AFTER_MS and still blocked → ONE forward to the next rung («escalated from <rung> after 5m»)
//   • a reply (replyTo = one of this block's mail ids — a structured field, never text matching) from ANY rung resumes the seat
//   • a seat with no coordinator, or that IS the coordinator, skips straight to the next rung; OP itself goes to the CEO card
// Machine fields ride in `refs` (block:/seat:/pane:/reason:) and `correlationId` = blockId; priority comes from intent=decision (P1).
import type { BlockReason } from '../agent-events/protocol.js';
import type { MessageEnvelope } from '../msg/msg-store.js';

export const ESCALATE_AFTER_MS = 5 * 60_000;

export interface NeedsHumanDeps {
  /** This seat's name; null = not a seat TUI (nothing is pushed). */
  readonly seat: () => string | null;
  readonly paneId: () => string;
  /** The seat's space coordinator (els workspace coordinator), or null/undefined when it has none. */
  readonly coordinatorOf: () => string | null | undefined;
  /** Posts one mail; returns its ledger id. */
  readonly postMail: (envelope: MessageEnvelope) => number | undefined;
  /** The CEO rung: an existing `decisions raise` card. */
  readonly raiseDecision: (card: { title: string; seat: string; reason: BlockReason; blockId: string; summary: string }) => void;
  /** A rung replied: resume the seat with the reply text as its input. */
  readonly resumeWith: (text: string) => void;
  readonly setTimer: (fn: () => void, ms: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
  readonly newBlockId?: () => string;
  readonly log?: (event: string, data: Record<string, unknown>) => void;
}

export interface NeedsHumanArrival { readonly msgId?: number; readonly replyTo?: number; readonly text: string }

export interface NeedsHumanPush {
  /** The TUI published the needs-person block. */
  blocked(reason: BlockReason, detail: string): void;
  /** The block is over (a person typed, or a turn was opened by a person). */
  resumed(): void;
  /** Mail arrivals of this seat: a structured reply to this block's mail resumes the seat. Returns true when it did. */
  noteArrivals(arrivals: readonly NeedsHumanArrival[] | undefined): boolean;
  activeBlockId(): string | null;
}

export function createNeedsHumanPush(deps: NeedsHumanDeps): NeedsHumanPush {
  let counter = 0;
  const newId = deps.newBlockId ?? (() => `blk-${Date.now().toString(36)}-${++counter}`);
  let active: { blockId: string; reason: BlockReason; detail: string; mailIds: Set<number>; rung: string; timer: unknown } | null = null;
  const log = (event: string, data: Record<string, unknown>): void => { try { deps.log?.(event, data); } catch { /* observation never breaks the turn */ } };

  const send = (seat: string, to: string, from: string | null, note?: string): void => {
    const block = active!;
    const line = block.detail || block.reason;
    const body = `[✋ NEED HUMAN · ${seat}] ${line} · 원하는 것: 이 막힘을 풀 결정·입력 (답장하면 그대로 재개) · 선택지: 재개/중단/다른 방법${note ? ` · ${note}` : ''}`;
    const id = deps.postMail({ from: seat, to, kind: 'request', intent: 'decision', body, correlationId: block.blockId,
      refs: [`block:${block.blockId}`, `seat:${seat}`, `pane:${deps.paneId()}`, `reason:${block.reason}`] });
    if (typeof id === 'number') block.mailIds.add(id);
    block.rung = to;
    log('seat.needs-human', { phase: from === null ? 'routed' : 'escalated', rung: to, ...(from === null ? {} : { from, to, afterMs: ESCALATE_AFTER_MS }), seat, blockId: block.blockId });
  };
  const toCeo = (seat: string): void => {
    const block = active!;
    block.rung = 'CEO';
    log('seat.needs-human', { phase: 'routed', rung: 'CEO', seat, blockId: block.blockId });
    try {
      deps.raiseDecision({ title: `[✋ NEED HUMAN · ${seat}] ${block.detail || block.reason}`, seat, reason: block.reason, blockId: block.blockId,
        summary: `${seat} is blocked and needs a person (${block.reason}). Choices: resume / stop / another way.` });
    } catch (error) { log('seat.needs-human', { phase: 'decision-raise-failed', error: String(error).slice(0, 160), seat }); }
  };
  const arm = (seat: string): void => {
    const block = active!;
    block.timer = deps.setTimer(() => {
      if (active !== block) return;
      const from = block.rung;
      if (from === 'OP' || seat === 'OP') {
        // The last mail rung went unanswered: a direction call (HUMAN_DECISION) reaches the CEO as a decision card.
        if (block.reason === 'HUMAN_DECISION' && from !== 'CEO') toCeo(seat);
        return;
      }
      send(seat, 'OP', from, `escalated from ${from} after 5m`);
      arm(seat);
    }, ESCALATE_AFTER_MS);
  };

  return {
    blocked(reason, detail) {
      const seat = deps.seat();
      if (!seat) return;
      if (active && active.reason === reason) return;   // the same block persisting: one mail per blockId
      if (active) { deps.clearTimer(active.timer); active = null; }
      active = { blockId: newId(), reason, detail, mailIds: new Set(), rung: '', timer: null };
      const coordinator = deps.coordinatorOf();
      const first = coordinator && coordinator !== seat ? coordinator : seat === 'OP' ? 'CEO' : 'OP';
      if (first === 'CEO') { toCeo(seat); return; }
      send(seat, first, null);
      arm(seat);
    },
    resumed() {
      if (!active) return;
      deps.clearTimer(active.timer);
      active = null;
    },
    noteArrivals(arrivals) {
      const block = active;
      if (!block || !arrivals) return false;
      const hit = arrivals.find((a) => a.replyTo !== undefined && block.mailIds.has(a.replyTo));
      if (!hit) return false;
      deps.clearTimer(block.timer);
      active = null;
      log('seat.needs-human', { phase: 'resumed-by-reply', rung: block.rung, blockId: block.blockId, replyTo: hit.replyTo });
      deps.resumeWith(hit.text);
      return true;
    },
    activeBlockId: () => active?.blockId ?? null,
  };
}
