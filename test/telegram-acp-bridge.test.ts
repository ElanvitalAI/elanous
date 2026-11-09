// MVP M2.1 — Telegram → daemon bridge tests.
//
// Boot a daemon on a tmp socket with stub runTurn, then drive a
// `runTurnImpl` from the bridge as if the bot just received a
// message. Verify:
//   - First call attaches a fresh ACP session
//   - Second call with same telegram session id reuses the cached
//     attach (no second connect)
//   - Different telegram session ids get different ACP sessions
//   - bridge.close() tears down all attaches

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';

import { bootAcpServer } from '../src/boot/acp-server.js';
import { readInputSourceMeta } from '../src/acp/input-source-meta.js';
import {
  defaultControlSignalBus,
  _resetDefaultControlSignalBusForTesting,
} from '../src/input/control-signal.js';
import { defaultControlSignalObserver, _resetDefaultControlSignalObserverForTesting } from '../src/input/control-signal-observer.js';
import { createTelegramAcpBridge } from '../src/telegram-acp-bridge.js';
import type { UserConfig } from '../src/user-config/types.js';
import { waitForSocket } from './helpers/wait-for-socket.js';

let tmp: string;
let sockPath: string;

beforeEach(() => {
  tmp = mkdtempSync(joinPath(tmpdir(), 'elanous-tg-bridge-test-'));
  sockPath = joinPath(tmp, 'elanous.sock');
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  _resetDefaultControlSignalBusForTesting();
  _resetDefaultControlSignalObserverForTesting();
});

function dummyConfig(): UserConfig {
  return {} as unknown as UserConfig;
}

describe('TelegramAcpBridge', () => {
  test('attaches once per telegram session id; reuses on next turn', async () => {
    const shutdownCtrl = new AbortController();
    const stubRunTurn = async (turnCtx: {
      userText: string;
      push: (text: string) => Promise<void>;
    }): Promise<void> => {
      await turnCtx.push(`reply:${turnCtx.userText}`);
    };
    const serverPromise = bootAcpServer(
      { transport: 'unix-socket', socketPath: sockPath },
      { shutdownSignal: shutdownCtrl.signal, runTurn: stubRunTurn },
    );
    await waitForSocket(sockPath);

    const bridge = createTelegramAcpBridge({ socketPath: sockPath });
    expect(bridge.cacheSize()).toBe(0);

    // Turn 1.
    let acc1 = '';
    const r1 = await bridge.runTurnImpl({
      userConfig: dummyConfig(),
      sessionId: 'tg-session-A',
      userText: 'hello',
      onDelta: (d) => { acc1 += d; },
    });
    expect(r1.text).toBe('reply:hello');
    expect(acc1).toBe('reply:hello');
    expect(bridge.cacheSize()).toBe(1);

    // Turn 2 — same telegram session id → cache hit.
    let acc2 = '';
    const r2 = await bridge.runTurnImpl({
      userConfig: dummyConfig(),
      sessionId: 'tg-session-A',
      userText: 'world',
      onDelta: (d) => { acc2 += d; },
    });
    expect(r2.text).toBe('reply:world');
    expect(acc2).toBe('reply:world');
    expect(bridge.cacheSize()).toBe(1);

    // Different telegram session → new attach.
    await bridge.runTurnImpl({
      userConfig: dummyConfig(),
      sessionId: 'tg-session-B',
      userText: 'second chat',
    });
    expect(bridge.cacheSize()).toBe(2);

    await bridge.close();
    expect(bridge.cacheSize()).toBe(0);
    shutdownCtrl.abort();
    try { await serverPromise; } catch { /* ignore */ }
  });

  test('throws helpful error when daemon is not reachable + auto-spawn off', async () => {
    const bridge = createTelegramAcpBridge({
      socketPath: joinPath(tmp, 'no-such.sock'),
      autoSpawn: false,
      log: () => {},
    });
    await expect(
      bridge.runTurnImpl({
        userConfig: dummyConfig(),
        sessionId: 'whatever',
        userText: 'hi',
      }),
    ).rejects.toThrow(/no elanous daemon/);
    await bridge.close();
  });

  test('result.text accumulates ALL chunks across multi-chunk runTurn', async () => {
    const shutdownCtrl = new AbortController();
    const stubRunTurn = async (turnCtx: {
      userText: string;
      push: (text: string) => Promise<void>;
    }): Promise<void> => {
      void turnCtx.userText;
      await turnCtx.push('one ');
      await turnCtx.push('two ');
      await turnCtx.push('three');
    };
    const serverPromise = bootAcpServer(
      { transport: 'unix-socket', socketPath: sockPath },
      { shutdownSignal: shutdownCtrl.signal, runTurn: stubRunTurn },
    );
    await waitForSocket(sockPath);

    const bridge = createTelegramAcpBridge({ socketPath: sockPath });
    const deltas: string[] = [];
    const r = await bridge.runTurnImpl({
      userConfig: dummyConfig(),
      sessionId: 'tg-multi',
      userText: 'hi',
      onDelta: (d) => deltas.push(d),
    });
    expect(r.text).toBe('one two three');
    expect(deltas.join('')).toBe('one two three');

    await bridge.close();
    shutdownCtrl.abort();
    try { await serverPromise; } catch { /* ignore */ }
  });

  test('forwards canonical telegram source meta through the daemon prompt', async () => {
    const captured: Array<Record<string, unknown> | undefined> = [];
    const shutdownCtrl = new AbortController();
    const serverPromise = bootAcpServer(
      { transport: 'unix-socket', socketPath: sockPath },
      {
        shutdownSignal: shutdownCtrl.signal,
        runTurn: async (turnCtx) => {
          captured.push(turnCtx.promptMeta as Record<string, unknown> | undefined);
          await turnCtx.push('ok');
        },
      },
    );
    await waitForSocket(sockPath);

    const bridge = createTelegramAcpBridge({ socketPath: sockPath });
    await bridge.runTurnImpl({
      userConfig: dummyConfig(),
      sessionId: 'tg-meta',
      userText: 'hello',
    });

    expect(captured).toHaveLength(1);
    expect(readInputSourceMeta(captured[0])).toEqual({
      kind: 'telegram',
      family: 'communication',
      provider: 'telegram',
      entry: 'text',
      relay: 'daemon-bridge',
    });
    expect(defaultControlSignalBus().list({ kind: 'turn-submit-begin' })).toEqual([
      expect.objectContaining({
        kind: 'turn-submit-begin',
        urgency: 'priority',
        scope: expect.objectContaining({
          channel: 'telegram',
          surface: 'daemon-session',
          sessionId: 'tg-meta',
        }),
      }),
    ]);

    await bridge.close();
    shutdownCtrl.abort();
    try { await serverPromise; } catch { /* ignore */ }
  });

  test('rejects daemon-session submit when a recent telegram quick-pass signal exists', async () => {
    const observer = defaultControlSignalObserver();
    observer.clear();
    const shutdownCtrl = new AbortController();
    const stubRunTurn = async (turnCtx: {
      userText: string;
      push: (text: string) => Promise<void>;
    }): Promise<void> => {
      await turnCtx.push(`reply:${turnCtx.userText}`);
    };
    const serverPromise = bootAcpServer(
      { transport: 'unix-socket', socketPath: sockPath },
      { shutdownSignal: shutdownCtrl.signal, runTurn: stubRunTurn },
    );
    await waitForSocket(sockPath);

    const bridge = createTelegramAcpBridge({ socketPath: sockPath });
    defaultControlSignalBus().emit({
      kind: 'turn-submit-abort',
      urgency: 'quick-pass',
      source: 'sensor',
      scope: {
        channel: 'telegram',
        surface: 'daemon-session',
        sessionId: 'tg-gated',
      },
    });

    await expect(
      bridge.runTurnImpl({
        userConfig: dummyConfig(),
        sessionId: 'tg-gated',
        userText: 'hello',
      }),
    ).rejects.toThrow(/submit aborted by recent turn-submit-abort quick-pass signal/);

    await bridge.close();
    shutdownCtrl.abort();
    try { await serverPromise; } catch { /* ignore */ }
  });
});
