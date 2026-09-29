import { expect, test } from 'bun:test';
import { runAcpServer } from './server.js';

const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } };
const newSession = { jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: '/tmp', mcpServers: [] } };

async function stdioAfterEof(delayMs: number | 'never', timeoutMs: number) {
  const encoder = new TextEncoder();
  const input = new TransformStream<Uint8Array, Uint8Array>();
  const lines: string[] = [];
  let text = '';
  let outputClosed = false;
  const output = new WritableStream<Uint8Array>({
    write(chunk) {
      text += new TextDecoder().decode(chunk);
      const parts = text.split('\n');
      text = parts.pop() ?? '';
      lines.push(...parts.filter(Boolean));
    },
    close() { outputClosed = true; },
  });
  const server = runAcpServer({
    stdioInput: input.readable,
    stdioOutput: output,
    stdioDrainTimeoutMs: timeoutMs,
    beforeNewSession: () => delayMs === 'never'
      ? new Promise<void>(() => {})
      : new Promise((resolve) => setTimeout(resolve, delayMs)),
  });
  const writer = input.writable.getWriter();
  await writer.write(encoder.encode(JSON.stringify(initialize) + '\n' + JSON.stringify(newSession) + '\n'));
  await writer.close();
  let guard: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      server,
      new Promise<never>((_, reject) => {
        guard = setTimeout(() => reject(new Error('server did not exit after EOF')), 5_000);
      }),
    ]);
  } finally {
    if (guard) clearTimeout(guard);
  }
  return {
    responses: lines.map((line) => JSON.parse(line) as { id: number; result?: { protocolVersion?: number; sessionId?: string } }),
    outputClosed,
  };
}

test('stdio EOF waits for a delayed session/new response', async () => {
  const { responses, outputClosed } = await stdioAfterEof(500, 2_000);
  expect(outputClosed).toBe(true);
  expect(responses.map((r) => r.id).sort()).toEqual([1, 2]);
  expect(responses.find((r) => r.id === 1)?.result?.protocolVersion).toBe(1);
  expect(responses.find((r) => r.id === 2)?.result?.sessionId).toMatch(/^elanous-session-/);
});

test('stdio EOF exits by deadline when session/new stays pending', async () => {
  const start = Date.now();
  const { responses, outputClosed } = await stdioAfterEof('never', 100);
  expect(outputClosed).toBe(true);
  expect(Date.now() - start).toBeGreaterThanOrEqual(80);
  expect(Date.now() - start).toBeLessThan(1_500);
  expect(responses.some((r) => r.id === 2)).toBe(false);
});
