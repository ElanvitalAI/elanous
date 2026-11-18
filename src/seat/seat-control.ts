/** Caller must derive sender and host from the transport, never from request payload. Same-uid seat identity is a policy boundary. */
export function authorizeSeatControl(input: { sender: string; target: string; sameHost: boolean }): boolean {
  return input.sameHost && input.sender.length > 0 && input.target.length > 0
    && (input.sender === 'OP' || input.sender === 'RES-INFRA' || input.sender === input.target);
}

export type SeatControlMode = 'quit' | 'migrate' | 'force';
type Pending = { mode: SeatControlMode; session?: string };
export interface SeatControlPorts {
  checkpoint(mode: SeatControlMode): Promise<void>;
  exit(): void;
  migrate(sessionId: string): void;
  abort(): void;
}

/** The host supplies turn boundaries and owns checkpoint persistence and restart/exit effects. */
export function createSeatControl(ports: SeatControlPorts) {
  let pending: Pending | null = null;
  let started = false;
  async function finish(request: Pending): Promise<void> {
    if (started) return;
    started = true;
    pending = null;
    if (request.mode === 'force') {
      ports.abort();
      try { await ports.checkpoint('force'); } catch { /* force is best effort */ }
      ports.exit();
    } else {
      try { await ports.checkpoint(request.mode); } catch (error) { started = false; throw error; }
      if (request.mode === 'migrate') ports.migrate(request.session!);
      else ports.exit();
    }
  }
  return {
    async request(mode: SeatControlMode, busy: boolean, session?: string): Promise<'waiting' | 'accepted' | 'missing-session' | 'already-requested'> {
      if (mode === 'migrate' && !session?.trim()) return 'missing-session';
      if (started || (pending && mode !== 'force')) return 'already-requested';
      const request: Pending = { mode, ...(session ? { session } : {}) };
      if (busy && mode !== 'force') { pending = request; return 'waiting'; }
      await finish(request);
      return 'accepted';
    },
    async turnEnded(): Promise<void> { if (pending) await finish(pending); },
  };
}
