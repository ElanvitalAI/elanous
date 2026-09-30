// Unit tests for ACP BackgroundNotifier — H3 #6.
//
// Exercises the manager-subscription + Pushcut-or-fallback dispatch
// matrix with an in-memory fake PushcutClient + log sink.

import { describe, expect, test } from 'bun:test';
import { createBackgroundManager } from '../src/acp/background-manager.js';
import { createBackgroundNotifier } from '../src/acp/background-notifier.js';
import type { PushcutClient, PushcutSendResult } from '../src/pushcut/client.js';

function makeFakePushcut(opts: {
  configured?: boolean;
  onNotify?: (name: string, body: any) => void;
  sendResult?: PushcutSendResult;
} = {}): PushcutClient {
  return {
    configured: opts.configured !== false,
    async notify(name, payload) {
      if (opts.onNotify) opts.onNotify(name, payload);
      return opts.sendResult ?? { ok: true, httpStatus: 200, body: '' };
    },
    async execute() {
      return { ok: false, reason: 'not-used' };
    },
  };
}

function makeHarness(pushcut: PushcutClient, logFallback?: (m: string) => void) {
  const mgr = createBackgroundManager();
  let resolveTurn!: (r: { stopReason: any }) => void;
  let rejectTurn!: (e: Error) => void;
  const turnPromise = new Promise<{ stopReason: any }>((res, rej) => {
    resolveTurn = res;
    rejectTurn = rej;
  });
  let feedChunk: (text: string) => void = () => {};
  let signalWaiting: () => void = () => {};
  let signalResumed: () => void = () => {};
  const record = mgr.start({
    clientSessionId: 'acp-cli:claude:abc',
    backendSessionId: 'abc',
    backendId: 'claude',
    cwd: '/tmp',
    initialMessage: 'refactor the auth module',
    turnPromise,
    registerChunk: (f) => { feedChunk = f; },
    registerApprovalSignal: (w, r) => { signalWaiting = w; signalResumed = r; },
  });
  const opts: Parameters<typeof createBackgroundNotifier>[0] = {
    manager: mgr,
    pushcut,
  };
  if (logFallback) opts.logFallback = logFallback;
  const notifier = createBackgroundNotifier(opts);
  return {
    mgr,
    record,
    feedChunk,
    signalWaiting,
    signalResumed,
    resolveTurn: (r: string) => resolveTurn({ stopReason: r }),
    rejectTurn,
    notifier,
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

describe('BackgroundNotifier · pushcut dispatch', () => {
  test('fires on waiting_for_confirmation', async () => {
    const calls: Array<{ name: string; payload: any }> = [];
    const pc = makeFakePushcut({
      onNotify: (name, payload) => calls.push({ name, payload }),
    });
    const h = makeHarness(pc);
    h.signalWaiting();
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe('elanous-background-agent');
    expect(calls[0]?.payload.title).toContain('needs your approval');
    h.notifier.dispose();
  });

  test('fires on completed with output in body', async () => {
    const calls: Array<{ name: string; payload: any }> = [];
    const pc = makeFakePushcut({
      onNotify: (name, payload) => calls.push({ name, payload }),
    });
    const h = makeHarness(pc);
    h.feedChunk('plan approved and applied');
    h.resolveTurn('end_turn');
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.payload.title).toContain('finished');
    expect(calls[0]?.payload.text).toContain('plan approved');
    h.notifier.dispose();
  });

  test('fires on failed with error in body', async () => {
    const calls: Array<{ name: string; payload: any }> = [];
    const pc = makeFakePushcut({
      onNotify: (name, payload) => calls.push({ name, payload }),
    });
    const h = makeHarness(pc);
    h.rejectTurn(new Error('claude-code-acp crashed: ENOENT'));
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.payload.title).toContain('failed');
    expect(calls[0]?.payload.text).toContain('ENOENT');
    h.notifier.dispose();
  });

  test('does NOT fire on cancelled (user initiated)', async () => {
    const calls: Array<{ name: string; payload: any }> = [];
    const pc = makeFakePushcut({
      onNotify: (name, payload) => calls.push({ name, payload }),
    });
    const h = makeHarness(pc);
    await h.mgr.cancel(h.record.id, async () => {});
    await flush();
    expect(calls).toHaveLength(0);
    h.notifier.dispose();
  });

  test('does NOT fire on transient back-to-running', async () => {
    const calls: Array<{ name: string; payload: any }> = [];
    const pc = makeFakePushcut({
      onNotify: (name, payload) => calls.push({ name, payload }),
    });
    const h = makeHarness(pc);
    h.signalWaiting();
    await flush();
    expect(calls).toHaveLength(1); // only the waiting push
    h.signalResumed();
    await flush();
    expect(calls).toHaveLength(1); // no second push for running
    h.notifier.dispose();
  });
});

describe('BackgroundNotifier · log fallback', () => {
  test('logFallback used when pushcut unconfigured', async () => {
    const pc = makeFakePushcut({ configured: false });
    const logs: string[] = [];
    const h = makeHarness(pc, (m) => logs.push(m));
    h.signalWaiting();
    await flush();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('needs your approval');
    h.notifier.dispose();
  });

  test('logFallback used when pushcut notify fails', async () => {
    const pc = makeFakePushcut({
      sendResult: { ok: false, reason: 'rate-limited' },
    });
    const logs: string[] = [];
    const h = makeHarness(pc, (m) => logs.push(m));
    h.signalWaiting();
    await flush();
    expect(logs).toHaveLength(1);
    h.notifier.dispose();
  });

  test('silent when neither pushcut nor logFallback', async () => {
    const pc = makeFakePushcut({ configured: false });
    const h = makeHarness(pc);
    // No logFallback passed · just silence.
    expect(() => h.signalWaiting()).not.toThrow();
    await flush();
    h.notifier.dispose();
  });
});

describe('BackgroundNotifier · dispose', () => {
  test('dispose stops further dispatch', async () => {
    const calls: Array<{ name: string; payload: any }> = [];
    const pc = makeFakePushcut({
      onNotify: (name, payload) => calls.push({ name, payload }),
    });
    const h = makeHarness(pc);
    h.notifier.dispose();
    h.resolveTurn('end_turn');
    await flush();
    expect(calls).toHaveLength(0);
  });

  test('dispose idempotent', async () => {
    const pc = makeFakePushcut();
    const h = makeHarness(pc);
    h.notifier.dispose();
    expect(() => h.notifier.dispose()).not.toThrow();
  });
});
