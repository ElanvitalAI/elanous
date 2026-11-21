// ELN-AGENT-EVENT-PROTOCOL — the TUI's turn/state signal → agent events (what a frame such as els reads).
// Push only: the sink is injected and structural, so this file knows neither the wire nor els (guarded by
// src/els/boundary.test.ts). Without a sink (no ELANOUS_EVENT_SOCKET) every call is a no-op.
import { randomUUID } from 'node:crypto';

/** Structural subset of the neutral emitter (src/agent-events/emit.ts) — a test double needs only these. */
export interface AgentEventSink {
  state(state: 'working' | 'idle' | 'blocked' | 'waiting-input', message?: string): void;
  turn(phase: 'start' | 'end', id: string): void;
  notice(level: 'info' | 'warn' | 'alert', text: string): void;
}

export interface AgentEventBridge {
  /** One busy flip = one turn boundary: true → turn start + working, false → turn end + idle. */
  busy(next: boolean): void;
  /** The pane waits on the user (approval, question) or is blocked; false returns to working/idle. */
  attention(kind: 'waiting-input' | 'blocked' | null): void;
  notice(level: 'info' | 'warn' | 'alert', text: string): void;
}

export function createAgentEventBridge(sink: AgentEventSink | undefined, newId: () => string = () => randomUUID().slice(0, 12)): AgentEventBridge {
  let turnId: string | null = null;
  const guard = (fn: (s: AgentEventSink) => void): void => { if (sink) { try { fn(sink); } catch { /* observation must not change the turn */ } } };
  return {
    busy(next) {
      if (next === (turnId !== null)) return;
      if (next) { turnId = newId(); const id = turnId; guard((s) => { s.turn('start', id); s.state('working'); }); return; }
      const id = turnId!; turnId = null;
      guard((s) => { s.turn('end', id); s.state('idle'); });
    },
    attention(kind) { guard((s) => s.state(kind ?? (turnId === null ? 'idle' : 'working'))); },
    notice(level, text) { guard((s) => s.notice(level, text)); },
  };
}
