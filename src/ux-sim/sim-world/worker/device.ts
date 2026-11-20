import { EVENT_PROTOCOL_VERSION, type AgentEvent, type AgentEventFrame } from '../../../agent-events/protocol.js';

export type SimWorkerKind = 'shell' | 'inline-agent' | 'pane-agent' | 'cli';
/** Temporary adapter seam until nexus registry/watch contract lands. No in-memory registry is substituted. */
export interface WorkerSimNexusPort {
  publish(kind: SimWorkerKind, frame: AgentEventFrame): Promise<void>;
}

/** Deterministic external worker device. It emits wire frames; it is not a worker state reducer. */
export function createWorkerSim(pane: string, now: () => number, kind: SimWorkerKind = 'pane-agent', incarnation = 1) {
  let seq = 0;
  const frame = (event: AgentEvent): AgentEventFrame => ({
    op: 'event', v: EVENT_PROTOCOL_VERSION, ws: 'SIM-WORKER', pane, sid: incarnation === 1 ? `sim-${pane}` : `sim-${pane}-r${incarnation}`, seq: ++seq, at: now(), event,
  });
  return {
    emit: frame,
    /** The sender process restarted in the same pane: a new sid, seq from 1 (WORKER-CONTRACT §1 · #38499 sid/seq rule). */
    restart() { return createWorkerSim(pane, now, kind, incarnation + 1); },
    async publish(port: WorkerSimNexusPort, event: AgentEvent): Promise<AgentEventFrame> {
      const emitted = frame(event);
      await port.publish(kind, emitted);
      return emitted;
    },
    /** A stalled worker emits no frame; the observer's clock must establish the timeout. */
    stall(): readonly AgentEventFrame[] { return []; },
    die(): AgentEventFrame { return frame({ kind: 'state', state: 'exited' }); },
    approval(): AgentEventFrame { return frame({ kind: 'state', state: 'blocked', message: 'approval required' }); },
    /** Return a duplicate and then an older frame without rewriting their sequence numbers. */
    duplicateAndLate(first: AgentEventFrame, newer: AgentEventFrame): readonly AgentEventFrame[] { return [newer, newer, first]; },
    flood(count: number): AgentEventFrame[] {
      return Array.from({ length: count }, (_, index) => frame({ kind: 'notice', level: 'info', text: `output-${index + 1}` }));
    },
  };
}
