interface TerminalInputSenderOptions {
  send: (method: string, params: {
    sessionId: string;
    terminalId: string;
    data: string;
    peerId: string;
  }) => Promise<unknown>;
  ready: Promise<string>;
  getSessionId: () => string;
  terminalId: string;
  getPeerId: () => string;
  log: (event: string, details: { reason: string; dropped: number }) => void;
}

export function createTerminalInputSender({
  send, ready, getSessionId, terminalId, getPeerId, log,
}: TerminalInputSenderOptions) {
  const queue: string[] = [];
  let readySessionId = '';
  let sessionConfirmedAfterReady = false;
  let draining = false;
  let disposed = false;
  let readinessFailed = false;
  let readinessError: unknown;

  const drop = (reason: unknown, pending = '') => {
    if (disposed) return;
    const dropped = new TextEncoder().encode(pending + queue.join('')).length;
    queue.length = 0;
    log('webterm.input.send-error', { reason: String(reason), dropped });
  };

  const drain = async () => {
    if (!readySessionId || draining || disposed) return;
    draining = true;
    try {
      while (queue.length && !disposed) {
        const data = queue.shift()!;
        try {
          const currentSessionId = getSessionId();
          await send('terminal/input', {
            sessionId: sessionConfirmedAfterReady && currentSessionId ? currentSessionId : readySessionId,
            terminalId, data, peerId: getPeerId(),
          });
        } catch (error) {
          drop(error, data);
          break;
        }
      }
    } finally {
      draining = false;
    }
  };

  void ready.then(
    (sessionId) => {
      if (disposed) return;
      if (!sessionId) {
        readinessFailed = true;
        readinessError = 'ACP handshake returned no session';
        drop(readinessError);
        return;
      }
      readySessionId = sessionId;
      void drain();
    },
    (error) => {
      readinessFailed = true;
      readinessError = error;
      drop(error);
    },
  );

  return {
    confirmSession(sessionId: string) {
      if (!disposed && readySessionId && sessionId) sessionConfirmedAfterReady = true;
    },
    push(data: string) {
      if (disposed) return;
      if (readinessFailed) {
        drop(readinessError, data);
        return;
      }
      queue.push(data);
      void drain();
    },
    dispose() {
      disposed = true;
      queue.length = 0;
    },
  };
}
