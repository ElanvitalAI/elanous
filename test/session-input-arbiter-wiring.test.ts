import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bootAcpServer } from '../src/boot/acp-server.js';
import { DaemonSessionHistory } from '../src/boot/daemon-runtime.js';
import * as coreTurnModule from '../src/core-turn/run-core-turn.js';
import { createDiscordAcpBridge } from '../src/discord-acp-bridge.js';
import { startNexusHttpServer } from '../src/nexus/api/http-server.js';
import { NexusEventBus } from '../src/nexus/api/event-bus.js';
import { createNexusState } from '../src/nexus/state/state.js';
import { TabRegistry } from '../src/nexus/state/tab-registry.js';
import { createChatTabSpec } from '../src/nexus/kinds/chat.js';
import {
  _clearTurnsForTest,
  acquireTurn,
  currentTurnHolder,
  releaseTurn,
} from '../src/session/session-input-arbiter.js';
import { createTelegramAcpBridge } from '../src/telegram-acp-bridge.js';
import type { UserConfig } from '../src/user-config.js';
import { waitForSocket } from './helpers/wait-for-socket.js';

let tmp: string;
let port = 54000;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'elanous-session-input-wiring-'));
  _clearTurnsForTest();
});

afterEach(() => {
  _clearTurnsForTest();
  rmSync(tmp, { recursive: true, force: true });
});

function uniquePort(): number {
  port += 1;
  return port;
}

function fixture() {
  const bus = new NexusEventBus();
  const state = createNexusState({ nexusVersion: 'test', phase: 'test' });
  state.bus = bus;
  const registry = new TabRegistry(state);
  registry.register(createChatTabSpec({ id: 'chat:input-arbiter' }));
  return { state, registry, bus };
}

async function drain(res: Response): Promise<string> {
  return await res.text();
}

describe.serial('session input arbiter runtime wiring', () => {
  test('Telegram caller runTurnImpl acquires before execution, rejects competing input with a human reply, and releases on success', async () => {
    const socketPath = join(tmp, 'telegram.sock');
    let executions = 0;
    const shutdown = new AbortController();
    const server = bootAcpServer(
      { transport: 'unix-socket', socketPath },
      { shutdownSignal: shutdown.signal, runTurn: async ({ push }) => { executions += 1; await push('ok'); } },
    );
    await waitForSocket(socketPath);
    const bridge = createTelegramAcpBridge({ socketPath });
    const sessionId = 'telegram-session';
    try {
      const result = await bridge.runTurnImpl({
        userConfig: {} as UserConfig,
        sessionId,
        userText: 'hello',
      });
      expect(result.text).toBe('ok');
      expect(executions).toBe(1);
      expect(currentTurnHolder(sessionId)).toBeNull();

      acquireTurn(sessionId, 'discord:daemon-session');
      const rejected = await bridge.runTurnImpl({
        userConfig: {} as UserConfig,
        sessionId,
        userText: 'blocked',
      });
      expect(rejected.text).toContain('discord:daemon-session');
      expect(executions).toBe(1);
      expect(currentTurnHolder(sessionId)).toBe('discord:daemon-session');
    } finally {
      await bridge.close();
      shutdown.abort();
      try { await server; } catch { /* shutdown */ }
    }
  });

  test('Telegram caller gives each concurrent turn a distinct prefixed key, rejects the second before execution, and preserves the active holder', async () => {
    const socketPath = join(tmp, 'telegram-concurrent.sock');
    let executions = 0;
    let releaseFirst!: () => void;
    const shutdown = new AbortController();
    let server: Promise<void>;
    const firstStarted = new Promise<void>((resolve) => {
      server = bootAcpServer(
        { transport: 'unix-socket', socketPath },
        { shutdownSignal: shutdown.signal, runTurn: async ({ push }) => {
          executions += 1;
          resolve();
          await new Promise<void>((release) => { releaseFirst = release; });
          await push('first');
        } },
      );
    });
    await waitForSocket(socketPath);
    const bridge = createTelegramAcpBridge({ socketPath });
    const sessionId = 'telegram-concurrent';
    try {
      const first = bridge.runTurnImpl({ userConfig: {} as UserConfig, sessionId, userText: 'first' });
      await firstStarted;
      const holder = currentTurnHolder(sessionId);
      expect(holder).toStartWith('telegram:daemon-session#');
      const second = await bridge.runTurnImpl({ userConfig: {} as UserConfig, sessionId, userText: 'second' });
      expect(second.text).toContain(holder!);
      expect(executions).toBe(1);
      expect(currentTurnHolder(sessionId)).toBe(holder);
      releaseFirst();
      await first;
      expect(currentTurnHolder(sessionId)).toBeNull();
    } finally {
      releaseFirst?.();
      await bridge.close();
      shutdown.abort();
      try { await server!; } catch { /* shutdown */ }
    }
  });

  test('Telegram caller runTurnImpl releases its acquired turn when execution throws', async () => {
    const socketPath = join(tmp, 'telegram-failure.sock');
    const shutdown = new AbortController();
    const server = bootAcpServer(
      { transport: 'unix-socket', socketPath },
      { shutdownSignal: shutdown.signal, runTurn: async () => { throw new Error('telegram failure'); } },
    );
    await waitForSocket(socketPath);
    const bridge = createTelegramAcpBridge({ socketPath });
    try {
      await expect(bridge.runTurnImpl({ userConfig: {} as UserConfig, sessionId: 'telegram-failure', userText: 'fail' })).rejects.toThrow('Internal error');
      expect(currentTurnHolder('telegram-failure')).toBeNull();
    } finally {
      await bridge.close();
      shutdown.abort();
      try { await server; } catch { /* shutdown */ }
    }
  });

  test('Discord caller runTurn acquires before execution, rejects competing input with a human reply, and releases on success', async () => {
    const socketPath = join(tmp, 'discord.sock');
    const shutdown = new AbortController();
    let executions = 0;
    const server = bootAcpServer(
      { transport: 'unix-socket', socketPath },
      { shutdownSignal: shutdown.signal, runTurn: async ({ push }) => { executions += 1; await push('ok'); } },
    );
    await waitForSocket(socketPath);
    const bridge = createDiscordAcpBridge({ socketPath, bindingsStorePath: join(tmp, 'bindings.json') });
    const sessionId = 'discord-session';
    try {
      bridge.setDaemonSessionForChannel({ channelId: 'channel', sessionId, lastSeenMsgIdx: 0 });
      expect((await bridge.runTurn({ channelId: 'channel', userText: 'hello' })).text).toBe('ok');
      expect(executions).toBe(1);
      expect(currentTurnHolder(sessionId)).toBeNull();

      acquireTurn(sessionId, 'telegram:daemon-session');
      const rejected = await bridge.runTurn({ channelId: 'channel', userText: 'blocked' });
      expect(rejected.text).toContain('telegram:daemon-session');
      expect(executions).toBe(1);
      expect(currentTurnHolder(sessionId)).toBe('telegram:daemon-session');
    } finally {
      await bridge.close();
      shutdown.abort();
      try { await server; } catch { /* shutdown */ }
    }
  });

  test('Discord caller gives each concurrent turn a distinct prefixed key and rejects the second before execution', async () => {
    const socketPath = join(tmp, 'discord-concurrent.sock');
    let executions = 0;
    let releaseFirst!: () => void;
    const shutdown = new AbortController();
    const firstStarted = new Promise<void>((resolve) => {
      void bootAcpServer(
        { transport: 'unix-socket', socketPath },
        { shutdownSignal: shutdown.signal, runTurn: async ({ push }) => {
          executions += 1;
          resolve();
          await new Promise<void>((release) => { releaseFirst = release; });
          await push('first');
        } },
      );
    });
    await waitForSocket(socketPath);
    const bridge = createDiscordAcpBridge({ socketPath, bindingsStorePath: join(tmp, 'bindings-concurrent.json') });
    const sessionId = 'discord-concurrent';
    try {
      bridge.setDaemonSessionForChannel({ channelId: 'channel', sessionId, lastSeenMsgIdx: 0 });
      const first = bridge.runTurn({ channelId: 'channel', userText: 'first' });
      await firstStarted;
      const holder = currentTurnHolder(sessionId);
      expect(holder).toStartWith('discord:daemon-session#');
      const second = await bridge.runTurn({ channelId: 'channel', userText: 'second' });
      expect(second.text).toContain(holder!);
      expect(executions).toBe(1);
      expect(currentTurnHolder(sessionId)).toBe(holder);
      releaseFirst();
      await first;
      expect(currentTurnHolder(sessionId)).toBeNull();
    } finally {
      releaseFirst?.();
      await bridge.close();
      shutdown.abort();
    }
  });

  test('Discord caller runTurn releases its acquired turn when execution throws', async () => {
    const socketPath = join(tmp, 'discord-failure.sock');
    const shutdown = new AbortController();
    const server = bootAcpServer(
      { transport: 'unix-socket', socketPath },
      { shutdownSignal: shutdown.signal, runTurn: async () => { throw new Error('discord failure'); } },
    );
    await waitForSocket(socketPath);
    const bridge = createDiscordAcpBridge({ socketPath, bindingsStorePath: join(tmp, 'bindings-failure.json') });
    try {
      bridge.setDaemonSessionForChannel({ channelId: 'channel', sessionId: 'discord-failure', lastSeenMsgIdx: 0 });
      await expect(bridge.runTurn({ channelId: 'channel', userText: 'fail' })).rejects.toThrow('Internal error');
      expect(currentTurnHolder('discord-failure')).toBeNull();
    } finally {
      await bridge.close();
      shutdown.abort();
      try { await server; } catch { /* shutdown */ }
    }
  });

  // HTTP server and SSE integration passed 10/10 under --timeout 20000; declare the same finite per-test budget.
  test('Nexus POST /v1/prompt/stream acquires before execution, emits holder on rejection, and releases on success', async () => {
    const fix = fixture();
    const history = new DaemonSessionHistory();
    const srv = startNexusHttpServer({
      ...fix,
      eventBus: fix.bus,
      startPort: uniquePort(),
      metaApi: { noAuth: true, history },
    });
    const sessionId = 'nexus-session';
    try {
      const success = await fetch(`${srv.url}/v1/prompt/stream`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, userText: 'hello' }),
      });
      await drain(success);
      expect(currentTurnHolder(sessionId)).toBeNull();

      acquireTurn(sessionId, 'telegram:daemon-session');
      // 거절은 「turn_busy 를 말한다」가 아니라 「턴을 «안 돌린다»」가 요구다. 그래서
      // 실행 진입점을 스파이로 세어 «무실행»을 명시적으로 문다 — 문면만 보면
      // 턴이 돌면서 turn_busy 도 나가는 경우를 통과시킨다.
      const runCoreTurn = spyOn(coreTurnModule, 'runCoreTurn');
      let body: string;
      try {
        const rejected = await fetch(`${srv.url}/v1/prompt/stream`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, userText: 'blocked' }),
        });
        body = await drain(rejected);
        expect(runCoreTurn).not.toHaveBeenCalled();
      } finally {
        runCoreTurn.mockRestore();
      }
      expect(body).toContain('turn_busy');
      expect(body).toContain('telegram:daemon-session');
      expect(currentTurnHolder(sessionId)).toBe('telegram:daemon-session');
    } finally {
      srv.stop();
    }
  }, 20_000);

  test('Nexus POST gives each concurrent request a distinct prefixed key and rejects the second before core execution', async () => {
    const runCoreTurn = spyOn(coreTurnModule, 'runCoreTurn').mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { setTimeout(resolve, 50); });
      return { stopReason: 'end_turn', finalText: 'first' };
    });
    const fix = fixture();
    const history = new DaemonSessionHistory();
    const srv = startNexusHttpServer({
      ...fix,
      eventBus: fix.bus,
      startPort: uniquePort(),
      metaApi: { noAuth: true, history },
    });
    const sessionId = 'nexus-concurrent';
    try {
      const first = fetch(`${srv.url}/v1/prompt/stream`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, userText: 'first' }),
      });
      await new Promise<void>((resolve) => { setTimeout(resolve, 10); });
      const holder = currentTurnHolder(sessionId);
      expect(holder).toStartWith('nexus:daemon-prompt#');
      const second = await fetch(`${srv.url}/v1/prompt/stream`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, userText: 'second' }),
      });
      expect(await drain(second)).toContain('turn_busy');
      expect(runCoreTurn).toHaveBeenCalledTimes(1);
      expect(currentTurnHolder(sessionId)).toBe(holder);
      await drain(await first);
      expect(currentTurnHolder(sessionId)).toBeNull();
    } finally {
      runCoreTurn.mockRestore();
      srv.stop();
    }
  });

  test('release of a different turn key cannot clear the active prefixed holder', () => {
    const sessionId = 'release-isolation';
    const first = 'telegram:daemon-session#first';
    const second = 'telegram:daemon-session#second';
    acquireTurn(sessionId, first);
    expect(acquireTurn(sessionId, second).granted).toBeFalse();
    releaseTurn(sessionId, second);
    expect(currentTurnHolder(sessionId)).toBe(first);
  });

  test('Nexus POST /v1/prompt/stream releases its acquired turn when execution fails', async () => {
    const runCoreTurn = spyOn(coreTurnModule, 'runCoreTurn').mockRejectedValueOnce(new Error('nexus failure'));
    const fix = fixture();
    const history = new DaemonSessionHistory();
    const srv = startNexusHttpServer({
      ...fix,
      eventBus: fix.bus,
      startPort: uniquePort(),
      metaApi: { noAuth: true, history },
    });
    try {
      const response = await fetch(`${srv.url}/v1/prompt/stream`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'nexus-failure', userText: 'hello' }),
      });
      const body = await drain(response);
      expect(body).toContain('turn_failed');
      expect(currentTurnHolder('nexus-failure')).toBeNull();
    } finally {
      runCoreTurn.mockRestore();
      srv.stop();
    }
  });
});
