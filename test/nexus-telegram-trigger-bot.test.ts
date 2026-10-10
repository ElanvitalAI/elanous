// V2.2-4 (2026-05-12) — NEXUS-hosted Telegram workflow trigger bot.
//
// Parallels `nexus-discord-trigger-bot.test.ts` (V2.2-3):
//   1. Factory returns null when token is empty (skip-wire pattern).
//   2. `toTelegramEvent` maps TgTriggerEvent → TelegramEvent
//      congruently (with optional `command` carry-through).
//   3. With an injected TelegramBot stub the construction does NOT
//      start polling and `handle.stop` forwards to bot.stop.
//   4. `buildTelegramTriggerTap` fan-out into dispatch · sync/async
//      throws are swallowed via the logger.

import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildTelegramTriggerTap,
  createNexusTelegramTriggerBot,
  createTelegramTriggerLogger,
  toTelegramEvent,
} from '../src/nexus/api/telegram-trigger-bot';
import { debug } from '../src/debug/log';
import { receiveChannelEvent } from '../src/nexus/outbound/router';
import { GRACEFUL_EXIT_CODE } from '../src/nexus/supervisor/graceful-exit';
import type { TgTriggerEvent } from '../src/telegram';
import type { TelegramEvent } from '../src/workflow-runtime/triggers/telegram-source';
import type { WorkflowDeps, WorkflowEntry } from '../src/workflow-runtime/types';
import type { UserConfig } from '../src/user-config';

const exitCodes: number[] = [];

const shutdownLogs: Array<{ event: string; data?: unknown }> = [];
const bootLogs: Array<{ event: string; data?: unknown }> = [];
const origLog = debug.log.bind(debug);
debug.log = ((category: string, event: string, data?: unknown) => {
  if (category === 'nexus.telegram.shutdown') shutdownLogs.push({ event, data });
  if (category === 'nexus.boot') bootLogs.push({ event, data });
  return origLog(category, event, data);
}) as typeof debug.log;

afterEach(() => {
  shutdownLogs.length = 0;
  bootLogs.length = 0;
  exitCodes.length = 0;
});

function makeStubBot(): {
  bot: { start: () => Promise<void>; stop: () => void; onCallbackQuery: () => void };
  startCalls: number;
  stopCalls: number;
} {
  let startCalls = 0;
  let stopCalls = 0;
  return {
    bot: {
      start: async () => { startCalls += 1; },
      stop: () => { stopCalls += 1; },
      onCallbackQuery: () => {},
    },
    get startCalls() { return startCalls; },
    get stopCalls() { return stopCalls; },
  };
}

describe('createTelegramTriggerLogger', () => {
  it('writes the unchanged stdout prefix and observes once without warning', () => {
    const stdout: string[] = [];
    const warnings: string[] = [];
    const observed: Array<[string, string]> = [];
    const log = createTelegramTriggerLogger({
      console: {
        log: (message?: unknown) => { stdout.push(String(message)); },
        warn: (message?: unknown) => { warnings.push(String(message)); },
      },
      observe: (category, event) => { observed.push([category, event]); },
    });

    log('bot starting (allowlist size 1)');

    expect(stdout).toEqual(['[telegram/trigger] bot starting (allowlist size 1)']);
    expect(warnings).toEqual([]);
    expect(observed).toEqual([['telegram.trigger', 'bot starting (allowlist size 1)']]);
  });
});

describe('createNexusTelegramTriggerBot · factory + tap wiring', () => {
  it('returns null when token is empty', () => {
    const handle = createNexusTelegramTriggerBot({
      token: '',
      allowedUsers: [],
      dispatch: async () => undefined,
    });
    expect(handle).toBeNull();
  });

  it('returns null when token is whitespace', () => {
    const handle = createNexusTelegramTriggerBot({
      token: '   ',
      allowedUsers: [],
      dispatch: async () => undefined,
    });
    expect(handle).toBeNull();
  });

  it('toTelegramEvent maps the message tap (no command field)', () => {
    const tap: TgTriggerEvent = {
      kind: 'message',
      chat: 'chat-1',
      user: 'user-1',
      body: 'hi',
      messageId: 42,
      isDm: true,
    };
    expect(receiveChannelEvent('telegram', tap)).toEqual({ text: 'hi', kind: 'message', channel: 'chat-1', senderId: 'user-1', messageId: 42 });
    const out = toTelegramEvent(tap);
    expect(out).toMatchObject({
      kind: 'message',
      chat: 'chat-1',
      user: 'user-1',
      body: 'hi',
    });
    expect(out.command).toBeUndefined();
    expect(out.raw).toBe(tap);
  });

  it('toTelegramEvent carries the command field through for /cmd taps', () => {
    const tap: TgTriggerEvent = {
      kind: 'command',
      chat: 'group-99',
      user: 'admin',
      body: 'arg1 arg2',
      command: 'runwf',
      messageId: 99,
      isDm: false,
    };
    const out = toTelegramEvent(tap);
    expect(out.kind).toBe('command');
    expect(out.command).toBe('runwf');
    expect(out.body).toBe('arg1 arg2');
  });
});

describe('createNexusTelegramTriggerBot · with injected bot stub', () => {
  it('does not call bot.start() when opts.bot is provided', () => {
    const stub = makeStubBot();
    const handle = createNexusTelegramTriggerBot({
      token: 'tok-test',
      allowedUsers: [123],
      dispatch: async () => undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      bot: stub.bot as any,
    });
    expect(handle).not.toBeNull();
    expect(stub.startCalls).toBe(0);
  });

  it('handle.stop() invokes bot.stop() exactly once', async () => {
    const stub = makeStubBot();
    const handle = createNexusTelegramTriggerBot({
      token: 'tok-test',
      allowedUsers: [],
      dispatch: async () => undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      bot: stub.bot as any,
    });
    await handle!.stop();
    expect(stub.stopCalls).toBe(1);
  });

  it('stop waits for a start promise that finishes one turn after 100ms, then logs drained', async () => {
    const stub = makeStubBot();
    let finishTurn!: () => void;
    const startPromise = new Promise<void>((resolve) => { finishTurn = resolve; });
    const handle = createNexusTelegramTriggerBot({
      token: 'tok-test',
      allowedUsers: [],
      dispatch: async () => undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      bot: stub.bot as any,
      startPromise,
    });
    const turn = new Promise<void>((resolve) => {
      setTimeout(() => { finishTurn(); resolve(); }, 100);
    });
    const startedAt = Date.now();
    const stopped = handle!.stop();
    await turn;
    await stopped;
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(90);
    expect(stub.stopCalls).toBe(1);
    expect(shutdownLogs.some((e) => e.event === 'drained')).toBe(true);
    const drained = shutdownLogs.find((e) => e.event === 'drained');
    expect((drained?.data as { elapsedMs: number }).elapsedMs).toBeGreaterThanOrEqual(90);
  });

  it('stop returns near timeoutMs when the start promise never settles and logs drain-timeout', async () => {
    const stub = makeStubBot();
    const startPromise = new Promise<void>(() => {});
    const handle = createNexusTelegramTriggerBot({
      token: 'tok-test',
      allowedUsers: [],
      dispatch: async () => undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      bot: stub.bot as any,
      startPromise,
    });
    const startedAt = Date.now();
    await handle!.stop({ timeoutMs: 50 });
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(400);
    expect(shutdownLogs).toEqual([{ event: 'drain-timeout', data: { timeoutMs: 50 } }]);
  });

  it('a second stop awaits the same drain and does not call bot.stop again', async () => {
    const stub = makeStubBot();
    let finishTurn!: () => void;
    const startPromise = new Promise<void>((resolve) => { finishTurn = resolve; });
    const handle = createNexusTelegramTriggerBot({
      token: 'tok-test',
      allowedUsers: [],
      dispatch: async () => undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      bot: stub.bot as any,
      startPromise,
    });
    const first = handle!.stop({ timeoutMs: 2_000 });
    const second = handle!.stop({ timeoutMs: 2_000 });
    let secondSettled = false;
    void second.then(() => { secondSettled = true; });
    await new Promise((r) => setTimeout(r, 40));
    expect(secondSettled).toBe(false);
    expect(stub.stopCalls).toBe(1);
    finishTurn();
    await first;
    await second;
    expect(stub.stopCalls).toBe(1);
    expect(shutdownLogs.filter((e) => e.event === 'drained')).toHaveLength(1);
  });
});

describe('buildTelegramTriggerTap · closure semantics', () => {
  it('fans synthetic taps into the dispatch callback as TelegramEvents', async () => {
    const seen: TelegramEvent[] = [];
    const tap = buildTelegramTriggerTap(
      async (event) => { seen.push(event); },
      () => {},
    );
    const synthetic: TgTriggerEvent = {
      kind: 'message',
      chat: '12345',
      user: 'alice',
      body: 'hello workflow',
      messageId: 1,
      isDm: true,
    };
    tap(synthetic);
    await new Promise((res) => setImmediate(res));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      kind: 'message',
      chat: '12345',
      user: 'alice',
      body: 'hello workflow',
    });
    expect(seen[0]?.raw).toBe(synthetic);
  });

  it('swallows dispatch errors via the logger (bot loop must keep flowing)', async () => {
    const logged: string[] = [];
    const tap = buildTelegramTriggerTap(
      async () => { throw new Error('daemon offline'); },
      (msg) => logged.push(msg),
    );
    tap({ kind: 'message', chat: 'c', user: 'u', body: 'b', messageId: 1, isDm: true });
    await new Promise((res) => setImmediate(res));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('daemon offline');
  });

  it('swallows synchronous throws from dispatch (defensive)', async () => {
    const logged: string[] = [];
    const tap = buildTelegramTriggerTap(
      () => { throw new Error('sync throw'); },
      (msg) => logged.push(msg),
    );
    tap({ kind: 'message', chat: 'c', user: 'u', body: 'b', messageId: 1, isDm: false });
    await new Promise((res) => setImmediate(res));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('sync throw');
  });
});
