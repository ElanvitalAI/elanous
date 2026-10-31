import { createServer, type Server } from 'node:http';

export type FakeOpenAiApiMode = 'ok' | 'unauthorized' | 'rate-limited' | 'disconnect' | 'slow';

/** Local OpenAI-compatible /v1/models endpoint for testing the production key verifier. */
export async function startFakeOpenAiCompatibleApi(mode: FakeOpenAiApiMode, delayMs = 350): Promise<{
  baseUrl: string;
  requests: () => number;
  close: () => Promise<void>;
}> {
  let requestCount = 0;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const server: Server = createServer((request, response) => {
    requestCount++;
    if (request.url !== '/v1/models') {
      response.writeHead(404).end();
      return;
    }
    if (mode === 'disconnect') {
      request.socket.destroy();
      return;
    }
    if (mode === 'slow') {
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (!response.destroyed) response.writeHead(200, { 'content-type': 'application/json' }).end('{"data":[]}');
      }, delayMs);
      timers.add(timer);
      return;
    }
    const status = mode === 'ok' ? 200 : mode === 'unauthorized' ? 401 : 429;
    response.writeHead(status, { 'content-type': 'application/json' }).end(mode === 'ok' ? '{"data":[]}' : '{}');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fake OpenAI API did not bind a TCP port');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests: () => requestCount,
    close: () => new Promise<void>((resolve, reject) => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}
