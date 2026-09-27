type ReplaySocket = Pick<WebSocket, 'addEventListener' | 'send' | 'close'>;

export function stripAnsi(text: string): string {
  return text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[^\[\]]/g, '');
}

interface ReplayOptions {
  baseUrl: string;
  sessionId: string;
  terminalId: string;
  timeoutMs: number;
}

/** Connect as a separate ACP client; never open a socket in the browser page. */
export async function readTerminalReplay(
  { baseUrl, sessionId, terminalId, timeoutMs }: ReplayOptions,
  connect: (url: string, origin: string) => ReplaySocket = (url, origin) => new WebSocket(url, { headers: { Origin: origin } } as unknown as string[]),
): Promise<string> {
  const origin = new URL(baseUrl).origin;
  const url = new URL('/v1/acp', origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = connect(url.href, origin);
  return new Promise<string>((resolve, reject) => {
    let done = false;
    const finish = (error?: Error, text?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* socket can already be closed */ }
      if (error) reject(error);
      else resolve(text!);
    };
    const timer = setTimeout(() => finish(new Error(`terminal replay timed out after ${timeoutMs}ms`)), timeoutMs);
    const send = (request: Record<string, unknown>) => {
      // 데몬 ACP 는 줄 단위 JSON(ndjson)이다 — 끝의 '\n' 이 없으면 서버가 프레임을 버퍼에 쥐고 처리하지 않는다
      // (PWA `daemon-client.ts` sendRaw 와 같다 · 2026-09-27 실측: 없으면 initialize 응답 0).
      if (!done) socket.send(`${JSON.stringify(request)}\n`);
    };
    socket.addEventListener('open', () => send({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: 1, clientInfo: { name: 'pwa-scenarios', version: '1.0.0' }, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } },
    }));
    const decoder = new TextDecoder();
    let buffered = '';
    socket.addEventListener('message', (event: MessageEvent) => {
      // 데몬은 바이트(Uint8Array/ArrayBuffer)로 보내고 한 프레임에 여러 줄이 올 수 있다.
      const data = event.data as unknown;
      buffered += typeof data === 'string' ? data
        : data instanceof ArrayBuffer ? decoder.decode(new Uint8Array(data))
        : ArrayBuffer.isView(data) ? decoder.decode(data as Uint8Array)
        : String(data);
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) handleLine(line);
    });
    const handleLine = (line: string) => {
      try {
        const message = JSON.parse(line) as { id?: number; error?: { message?: string }; result?: Record<string, unknown> };
        if (done || (message.id !== 1 && message.id !== 2 && message.id !== 3)) return;
        if (message.error) throw new Error(`ACP ${message.id}: ${message.error.message ?? 'request failed'}`);
        if (message.id === 1) {
          // 페이지 세션을 `session/load` 로 불러오지 않는다 — 데몬을 새로 띄우면 그 세션을 몰라 Internal error 가 났다
          // (2026-09-27 실물 3판 중 2판 T1b). 새 세션으로 붙어도 #20971 뒤로 같은 terminalId 의 살아 있는 셸에 attach 된다.
          send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: '/', mcpServers: [] } });
        } else if (message.id === 2) {
          const replaySession = typeof message.result?.sessionId === 'string' ? message.result.sessionId : sessionId;
          send({ jsonrpc: '2.0', id: 3, method: 'terminal/spawn', params: { sessionId: replaySession, terminalId, replay: true } });
        } else {
          if (message.result?.status !== 'attached' || typeof message.result.snapshot !== 'string') {
            throw new Error(`terminal replay not attached: ${JSON.stringify(message.result)}`);
          }
          finish(undefined, stripAnsi(message.result.snapshot));
        }
      } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    };
    socket.addEventListener('error', () => finish(new Error('terminal replay WebSocket error')));
    socket.addEventListener('close', () => finish(new Error('terminal replay WebSocket closed before response')));
  });
}
