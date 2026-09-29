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
  /** 셸이 입력을 받을 준비가 됐나 — 새로 뜬 셸은 첫 출력(프롬프트)까지 입력을 «모아 둔다».
   *  종전엔 ACP 핸드셰이크만 기다려, 셸이 아직 안 만들어진 7초 사이의 입력이 `unknown_terminal` 로 조용히 사라지거나
   *  아직 줄 편집기가 안 뜬 셸에 섞여 `cd` → `ccd` · ↑ → `^[[A` 가 됐다(2026-09-28 운영 · 부하 300 대 · 실 브라우저). */
  shellReady?: Promise<void>;
}

export function createTerminalInputSender({
  send, ready, getSessionId, terminalId, getPeerId, log, shellReady,
}: TerminalInputSenderOptions) {
  let shellOpen = !shellReady;
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
    if (!readySessionId || !shellOpen || draining || disposed) return;
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

  if (shellReady) void shellReady.then(() => { shellOpen = true; void drain(); });

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
