/** Buffers Next TUI shell snapshots that arrive before a REPL turn installs its listener. */
export function createShellSnapshotRouter() {
  const listeners = new Map<string, () => void>();
  const pending = new Set<string>();

  return {
    receive(message: unknown): boolean {
      if (message === null || typeof message !== 'object') return false;
      const request = message as { type?: unknown; turnId?: unknown };
      if (request.type !== 'elanous.next-tui.shell-snapshot' || typeof request.turnId !== 'string' || !request.turnId) return false;
      const listener = listeners.get(request.turnId);
      if (listener) listener();
      else pending.add(request.turnId);
      return true;
    },
    listen(turnId: string, listener: () => void): () => void {
      listeners.set(turnId, listener);
      if (pending.delete(turnId)) listener();
      return () => {
        if (listeners.get(turnId) === listener) listeners.delete(turnId);
        pending.delete(turnId);
      };
    },
  };
}

/** A push-now request is decided inside the child turn, in the same event-loop tick as tool dispatch. */
export function createPushNowRouter() {
  type PushNowRequest = { requestId: string; phase: 'probe' | 'commit' };
  const listeners = new Map<string, (request: PushNowRequest) => void>();
  const pending = new Map<string, PushNowRequest[]>();
  return {
    receive(message: unknown): boolean {
      if (message === null || typeof message !== 'object') return false;
      const request = message as { type?: unknown; turnId?: unknown; requestId?: unknown };
      if ((request.type !== 'elanous.next-tui.push-now' && request.type !== 'elanous.next-tui.push-now-commit')
        || typeof request.turnId !== 'string' || !request.turnId
        || typeof request.requestId !== 'string' || !request.requestId) return false;
      const routed: PushNowRequest = { requestId: request.requestId, phase: request.type === 'elanous.next-tui.push-now' ? 'probe' : 'commit' };
      const listener = listeners.get(request.turnId);
      if (listener) listener(routed);
      else pending.set(request.turnId, [...(pending.get(request.turnId) ?? []), routed]);
      return true;
    },
    listen(turnId: string, listener: (request: PushNowRequest) => void): () => void {
      listeners.set(turnId, listener);
      for (const request of pending.get(turnId) ?? []) listener(request);
      pending.delete(turnId);
      return () => {
        if (listeners.get(turnId) === listener) listeners.delete(turnId);
        pending.delete(turnId);
      };
    },
  };
}
