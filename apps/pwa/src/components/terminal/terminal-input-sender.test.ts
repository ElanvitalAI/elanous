import { describe, expect, test } from 'bun:test';
import { createTerminalInputSender } from './terminal-input-sender';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('createTerminalInputSender', () => {
  test('queues before ready, then sends each key chunk in order with the post-ready session', async () => {
    const ready = deferred<string>();
    const firstSend = deferred<unknown>();
    let sessionId = 'old-session';
    const sends: Array<{ method: string; sessionId: string; terminalId: string; data: string; peerId: string }> = [];
    const sender = createTerminalInputSender({
      send: (method, params) => {
        sends.push({ method, ...params });
        return sends.length === 1 ? firstSend.promise : Promise.resolve({});
      },
      ready: ready.promise,
      getSessionId: () => sessionId,
      terminalId: 'term-1',
      getPeerId: () => 'peer-1',
      log: () => {},
    });

    sender.push('ab');
    sender.push('c');
    expect(sends).toHaveLength(0);
    ready.resolve('new-session');
    await flush();
    expect(sessionId).toBe('old-session');
    expect(sends).toEqual([{ method: 'terminal/input', sessionId: 'new-session', terminalId: 'term-1', data: 'ab', peerId: 'peer-1' }]);
    sessionId = 'subsequent-session';
    firstSend.resolve({});
    await flush();
    expect(sends.map(({ data }) => data)).toEqual(['ab', 'c']);
    expect(sends.map(({ sessionId: sid }) => sid)).toEqual(['new-session', 'new-session']);
    sender.dispose();
  });

  test('sends a push immediately after ready', async () => {
    const sent: string[] = [];
    const sender = createTerminalInputSender({
      send: async (_method, params) => { sent.push(params.data); },
      ready: Promise.resolve('session'),
      getSessionId: () => 'session',
      terminalId: 'term-1',
      getPeerId: () => 'peer-1',
      log: () => {},
    });
    await flush();
    sender.push('x');
    expect(sent).toEqual(['x']);
    sender.dispose();
  });

  test('uses a confirmed session change after ready for later input', async () => {
    let sessionId = 'old-session';
    const sends: Array<{ data: string; sessionId: string }> = [];
    const sender = createTerminalInputSender({
      send: async (_method, params) => { sends.push({ data: params.data, sessionId: params.sessionId }); },
      ready: Promise.resolve('ready-session'),
      getSessionId: () => sessionId,
      terminalId: 'term-1',
      getPeerId: () => 'peer-1',
      log: () => {},
    });
    await flush();
    sender.push('before-change');
    await flush();
    sessionId = 'after-change';
    sender.confirmSession(sessionId);
    sender.push('after-change');
    await flush();
    expect(sends).toEqual([
      { data: 'before-change', sessionId: 'ready-session' },
      { data: 'after-change', sessionId: 'after-change' },
    ]);
    sender.dispose();
  });

  test('uses the ready ID before confirmation and the latest confirmed ID even when it equals the initial ID', async () => {
    let sessionId = 'A';
    const sends: Array<{ data: string; sessionId: string }> = [];
    const sender = createTerminalInputSender({
      send: async (_method, params) => { sends.push({ data: params.data, sessionId: params.sessionId }); },
      ready: Promise.resolve('B'),
      getSessionId: () => sessionId,
      terminalId: 'term-1',
      getPeerId: () => 'peer-1',
      log: () => {},
    });
    sender.confirmSession('A');
    sender.push('before-ready');
    await flush();
    sender.push('after-ready-before-confirmation');
    await flush();
    sessionId = 'A';
    sender.confirmSession('A');
    sender.push('after-confirmation');
    await flush();
    expect(sends).toEqual([
      { data: 'before-ready', sessionId: 'B' },
      { data: 'after-ready-before-confirmation', sessionId: 'B' },
      { data: 'after-confirmation', sessionId: 'A' },
    ]);
    sender.dispose();
  });

  test('logs dropped bytes and clears the pending queue when the first send fails', async () => {
    const failure = deferred<unknown>();
    const logs: Array<{ event: string; reason: string; dropped: number }> = [];
    const sent: string[] = [];
    const sender = createTerminalInputSender({
      send: (_method, params) => { sent.push(params.data); return failure.promise; },
      ready: Promise.resolve('session'),
      getSessionId: () => 'session',
      terminalId: 'term-1',
      getPeerId: () => 'peer-1',
      log: (event, details) => logs.push({ event, ...details }),
    });
    sender.push('ab');
    sender.push('한');
    await flush();
    failure.reject(new Error('offline'));
    await flush();
    expect(logs).toEqual([{ event: 'webterm.input.send-error', reason: 'Error: offline', dropped: 5 }]);
    sender.push('later');
    await flush();
    expect(sent).toEqual(['ab', 'later']);
    sender.dispose();
  });

  test('discards queued data on dispose before ready', async () => {
    const ready = deferred<string>();
    const sent: string[] = [];
    const sender = createTerminalInputSender({
      send: async (_method, params) => { sent.push(params.data); },
      ready: ready.promise,
      getSessionId: () => 'session',
      terminalId: 'term-1',
      getPeerId: () => 'peer-1',
      log: () => {},
    });
    sender.push('discard');
    sender.dispose();
    ready.resolve('session');
    await flush();
    expect(sent).toEqual([]);
  });
});
