import { describe, expect, test } from 'bun:test';
import { readTerminalReplay, stripAnsi } from './acp-replay.js';

class FakeSocket {
  handlers = new Map<string, Array<(event: any) => void>>();
  sent: Array<{ id: number; method: string; params: Record<string, unknown> }> = [];
  closed = false;
  addEventListener(type: string, listener: (event: any) => void) {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), listener]);
  }
  send(text: string) { this.sent.push(JSON.parse(text)); }
  close() { this.closed = true; }
  emit(type: string, data?: unknown) {
    for (const listener of this.handlers.get(type) ?? []) listener(type === 'message' ? { data: `${JSON.stringify(data)}\n` } : {});
  }
}

const options = { baseUrl: 'http://127.0.0.1:31455', sessionId: 'session-a', terminalId: 'term-a', timeoutMs: 100 };

async function connected() {
  const socket = new FakeSocket();
  let url = '';
  let origin = '';
  const result = readTerminalReplay(options, (target, header) => {
    url = target; origin = header;
    return socket;
  });
  socket.emit('open');
  socket.emit('message', { jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } });
  socket.emit('message', { jsonrpc: '2.0', id: 2, result: { sessionId: 'replay-session' } });
  return { socket, result, url, origin };
}

describe('ACP replay from the runner process', () => {
  test('initializes, opens its own session, attaches to the same terminal id with replay, and strips ANSI', async () => {
    const { socket, result, url, origin } = await connected();
    expect(url).toBe('ws://127.0.0.1:31455/v1/acp');
    expect(origin).toBe(options.baseUrl);
    expect(socket.sent.map((request) => request.method)).toEqual(['initialize', 'session/new', 'terminal/spawn']);
    expect(socket.sent[2]?.params).toEqual({ sessionId: 'replay-session', terminalId: 'term-a', replay: true });
    socket.emit('message', { jsonrpc: '2.0', id: 3, result: { status: 'attached', snapshot: '\x1b[32mmarker\x1b[0m marker' } });
    expect(await result).toBe('marker marker');
    expect(socket.closed).toBe(true);
    expect(stripAnsi('\x1b]0;title\x07\x1b[1mtext\x1b[0m')).toBe('text');
  });

  test('spawned shell instead of attached fails closed', async () => {
    const { socket, result } = await connected();
    socket.emit('message', { jsonrpc: '2.0', id: 3, result: { status: 'spawned' } });
    await expect(result).rejects.toThrow('not attached');
  });

  test('JSON-RPC rejection and premature close fail with a reason', async () => {
    const { socket, result } = await connected();
    socket.emit('message', { jsonrpc: '2.0', id: 3, error: { message: 'denied' } });
    await expect(result).rejects.toThrow('ACP 3: denied');
    const other = new FakeSocket();
    const closed = readTerminalReplay(options, () => other);
    other.emit('close');
    await expect(closed).rejects.toThrow('closed before response');
  });

  test('deadline rejects and closes the socket', async () => {
    const socket = new FakeSocket();
    const result = readTerminalReplay({ ...options, timeoutMs: 1 }, () => socket);
    await expect(result).rejects.toThrow('timed out');
    expect(socket.closed).toBe(true);
  });
});
