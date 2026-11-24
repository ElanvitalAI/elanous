// ELN-AGENT-EVENT-PROTOCOL — the TUI's turn/state signal → agent events (what a frame such as els reads).
// Push only: the sink is injected and structural, so this file knows neither the wire nor els (guarded by
// src/els/boundary.test.ts). Without a sink (no ELANOUS_EVENT_SOCKET) every call is a no-op.
// SEAT-STATE-ENUM: a block or an approval prompt is reported as a code (BLOCKED + one BlockReason, WAITING_APPROVAL),
// never as the sentence the person reads — the wording can change, the code does not.
import { randomUUID } from 'node:crypto';
import type { BlockReason, SeatState } from '../agent-events/protocol.js';

/** Structural subset of the neutral emitter (src/agent-events/emit.ts) — a test double needs only these. */
export interface AgentEventSink {
  state(state: 'working' | 'idle' | 'blocked' | 'waiting-input', message?: string): void;
  turn(phase: 'start' | 'end', id: string): void;
  notice(level: 'info' | 'warn' | 'alert', text: string): void;
  /** SEAT-STATE-ENUM code report; a sink without it gets the v1 `state` word instead. */
  seatState?(input: { state: SeatState; reason?: BlockReason; detail?: string }): void;
}

export interface AgentEventBridge {
  /** One busy flip = one turn boundary: true → turn start + working, false → turn end + idle (or the block noted in the turn). */
  busy(next: boolean): void;
  /** The pane waits on the user (approval, question) or is blocked; false returns to working/idle. */
  attention(kind: 'waiting-input' | 'blocked' | null): void;
  /** A person is needed: BLOCKED with exactly one reason. Inside a running turn it is reported at that turn's end. */
  blocked(reason: BlockReason, detail?: string): void;
  /** A person acted (opened a turn): the needs-person block is over. Reports IDLE when no turn is running. */
  resume(): void;
  /** An approval prompt opened (true) or closed (false). */
  approval(open: boolean): void;
  notice(level: 'info' | 'warn' | 'alert', text: string): void;
}

const LEGACY: Record<SeatState, 'working' | 'idle' | 'blocked' | 'waiting-input'> = {
  WORKING: 'working', STALLED: 'working', IDLE: 'idle', WAITING_REPLY: 'idle', EXITED: 'idle', WAITING_APPROVAL: 'waiting-input', BLOCKED: 'blocked',
};

export function createAgentEventBridge(sink: AgentEventSink | undefined, newId: () => string = () => randomUUID().slice(0, 12)): AgentEventBridge {
  let turnId: string | null = null;
  let pendingBlock: { reason: BlockReason; detail?: string } | null = null;
  // SIDETAB-TWO-MARKS: «a person is needed» is a latch, not an edge. A later turn of the seat's own (mail wake, watchdog) must not
  // turn the published state back to IDLE — only a person resumes it (resume()). Without this the block was overwritten by `idle`.
  let latched: { reason: BlockReason; detail?: string } | null = null;
  const guard = (fn: (s: AgentEventSink) => void): void => { if (sink) { try { fn(sink); } catch { /* observation must not change the turn */ } } };
  const report = (s: AgentEventSink, input: { state: SeatState; reason?: BlockReason; detail?: string }): void => {
    if (s.seatState) s.seatState(input); else s.state(LEGACY[input.state]);
  };
  return {
    busy(next) {
      if (next === (turnId !== null)) return;
      if (next) { turnId = newId(); pendingBlock = null; const id = turnId; guard((s) => { s.turn('start', id); s.state('working'); }); return; }
      const id = turnId!; turnId = null;
      const block = pendingBlock ?? latched; pendingBlock = null;
      if (block) latched = block;
      guard((s) => {
        s.turn('end', id);
        if (block) report(s, { state: 'BLOCKED', reason: block.reason, ...(block.detail ? { detail: block.detail } : {}) });
        else s.state('idle');
      });
    },
    attention(kind) {
      if (kind === null && turnId === null && latched) { const block = latched; guard((s) => report(s, { state: 'BLOCKED', ...block })); return; }
      guard((s) => s.state(kind ?? (turnId === null ? 'idle' : 'working')));
    },
    blocked(reason, detail) {
      const block = { reason, ...(detail ? { detail } : {}) };
      latched = block;
      if (turnId !== null) { pendingBlock = block; return; }
      guard((s) => report(s, { state: 'BLOCKED', ...block }));
    },
    resume() {
      if (!latched) return;
      latched = null; pendingBlock = null;
      if (turnId === null) guard((s) => report(s, { state: 'IDLE' }));
    },
    approval(open) {
      const back = latched && turnId === null ? { state: 'BLOCKED' as const, ...latched } : { state: turnId === null ? 'IDLE' as const : 'WORKING' as const };
      guard((s) => open ? report(s, { state: 'WAITING_APPROVAL', reason: 'APPROVAL_PENDING' }) : report(s, back));
    },
    notice(level, text) { guard((s) => s.notice(level, text)); },
  };
}
