// V2.2-3 (2026-05-12) — NEXUS-hosted Discord workflow trigger bot.
//
// Unit + integration smoke:
//   1. Factory returns null when token is empty (skip-wire pattern).
//   2. `toDiscordEvent` maps DcTriggerEvent → DiscordEvent congruently.
//   3. With an injected DiscordBot stub, the construction does NOT
//      start the gateway (test seam) and the onTriggerTap closure
//      fans inbound taps into `dispatch(...)`.
//   4. Dispatch errors are swallowed so a workflow daemon failure
//      doesn't crash the bot loop.

import { describe, expect, it } from 'bun:test';
import {
  buildDiscordTriggerTap,
  createDiscordTriggerLogger,
  createNexusDiscordTriggerBot,
  toDiscordEvent,
} from '../src/nexus/api/discord-trigger-bot';
import type { DcTriggerEvent } from '../src/discord';
import type { DiscordEvent } from '../src/workflow-runtime/triggers/discord-source';

// Minimal DiscordBot stub — implements just the surface the factory
// touches when `opts.bot` is injected: `start()` is skipped, `stop()`
// is called on handle.stop, plus the constructor side captures the
// `onTriggerTap` slot so tests can fire synthetic taps.
function makeStubBot(): {
  bot: {
    start: () => Promise<void>;
    stop: () => void;
    onTriggerTap?: (tap: DcTriggerEvent) => void;
  };
  startCalls: number;
  stopCalls: number;
  fireTap: (tap: DcTriggerEvent) => void;
} {
  let startCalls = 0;
  let stopCalls = 0;
  const slot: { onTriggerTap?: (tap: DcTriggerEvent) => void } = {};
  return {
    bot: {
      start: async () => { startCalls += 1; },
      stop: () => { stopCalls += 1; },
      get onTriggerTap() { return slot.onTriggerTap; },
      set onTriggerTap(fn: ((tap: DcTriggerEvent) => void) | undefined) { slot.onTriggerTap = fn; },
    },
    get startCalls() { return startCalls; },
    get stopCalls() { return stopCalls; },
    fireTap: (tap: DcTriggerEvent) => { slot.onTriggerTap?.(tap); },
  };
}

describe('createDiscordTriggerLogger', () => {
  it('writes the unchanged stdout prefix and observes once without warning', () => {
    const stdout: string[] = [];
    const warnings: string[] = [];
    const observed: Array<[string, string]> = [];
    const log = createDiscordTriggerLogger({
      console: {
        log: (message?: unknown) => { stdout.push(String(message)); },
        warn: (message?: unknown) => { warnings.push(String(message)); },
      },
      observe: (category, event) => { observed.push([category, event]); },
    });

    log('gateway connected');

    expect(stdout).toEqual(['[discord/trigger] gateway connected']);
    expect(warnings).toEqual([]);
    expect(observed).toEqual([['discord.trigger', 'gateway connected']]);
  });
});

describe('createNexusDiscordTriggerBot · factory + tap wiring', () => {
  it('returns null when token is empty', () => {
    const handle = createNexusDiscordTriggerBot({
      token: '',
      allowedUsers: [],
      dispatch: async () => undefined,
    });
    expect(handle).toBeNull();
  });

  it('returns null when token is whitespace', () => {
    const handle = createNexusDiscordTriggerBot({
      token: '   ',
      allowedUsers: [],
      dispatch: async () => undefined,
    });
    expect(handle).toBeNull();
  });

  it('toDiscordEvent maps the tap shape congruently with raw passthrough', () => {
    const tap: DcTriggerEvent = {
      kind: 'mention',
      channel: 'ch-123',
      user: 'user-456',
      body: 'hello @bot please run',
      messageId: 'msg-789',
      isDm: false,
    };
    const out = toDiscordEvent(tap);
    expect(out).toMatchObject({
      kind: 'mention',
      channel: 'ch-123',
      user: 'user-456',
      body: 'hello @bot please run',
    });
    // raw carries the original tap so downstream consumers can access
    // messageId / isDm without us widening DiscordEvent.
    expect(out.raw).toBe(tap);
  });
});

describe('createNexusDiscordTriggerBot · with injected bot stub', () => {
  it('does not call bot.start() when opts.bot is provided', () => {
    const stub = makeStubBot();
    const dispatched: DiscordEvent[] = [];
    const handle = createNexusDiscordTriggerBot({
      token: 'tok-test',
      allowedUsers: ['u1'],
      dispatch: async (e) => { dispatched.push(e); },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      bot: stub.bot as any,
    });
    expect(handle).not.toBeNull();
    expect(stub.startCalls).toBe(0);
  });

  it('handle.stop() invokes bot.stop() exactly once', async () => {
    const stub = makeStubBot();
    const handle = createNexusDiscordTriggerBot({
      token: 'tok-test',
      allowedUsers: [],
      dispatch: async () => undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      bot: stub.bot as any,
    });
    await handle!.stop();
    expect(stub.stopCalls).toBe(1);
  });
});

describe('buildDiscordTriggerTap · closure semantics', () => {
  it('fans synthetic taps into the dispatch callback as DiscordEvents', async () => {
    const seen: DiscordEvent[] = [];
    const tap = buildDiscordTriggerTap(
      async (event) => { seen.push(event); },
      () => {},
    );
    const synthetic: DcTriggerEvent = {
      kind: 'message',
      channel: 'general',
      user: 'alice',
      body: 'hello workflow',
      messageId: 'msg-1',
      isDm: true,
    };
    tap(synthetic);
    // Fire-and-forget — drain the microtask queue.
    await new Promise((res) => setImmediate(res));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      kind: 'message',
      channel: 'general',
      user: 'alice',
      body: 'hello workflow',
    });
    expect(seen[0]?.raw).toBe(synthetic);
  });

  it('swallows dispatch errors via the logger (bot loop must keep flowing)', async () => {
    const logged: string[] = [];
    const tap = buildDiscordTriggerTap(
      async () => { throw new Error('daemon offline'); },
      (msg) => logged.push(msg),
    );
    tap({ kind: 'message', channel: 'c', user: 'u', body: 'b', messageId: 'm', isDm: true });
    await new Promise((res) => setImmediate(res));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('daemon offline');
  });

  it('swallows synchronous throws from dispatch (defensive)', async () => {
    const logged: string[] = [];
    const tap = buildDiscordTriggerTap(
      () => { throw new Error('sync throw'); },
      (msg) => logged.push(msg),
    );
    tap({ kind: 'message', channel: 'c', user: 'u', body: 'b', messageId: 'm', isDm: false });
    await new Promise((res) => setImmediate(res));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('sync throw');
  });
});

describe('createNexusDiscordTriggerBot · EV12c chat channels', () => {
  class IdleWs {
    readyState = 0;
    onopen: unknown = null; onmessage: unknown = null; onclose: unknown = null; onerror: unknown = null;
    addEventListener(): void {}
    removeEventListener(): void {}
    send(): void {}
    close(): void {}
  }
  const build = (guildTextChannels?: string[]) => createNexusDiscordTriggerBot({
    token: 'tok-test',
    allowedUsers: ['u1'],
    dispatch: async () => undefined,
    ...(guildTextChannels ? { guildTextChannels } : {}),
    fetchImpl: (async () => new Response('{}')) as unknown as typeof fetch,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wsImpl: IdleWs as any,
    log: () => {},
  })!;

  it('forwards discord.chatChannels into the bot as guild text channels; absent stays DM-only', async () => {
    const scoped = build(['1500000000000000001']);
    const empty = build();
    const channels = (h: typeof scoped) => [...(h.bot as unknown as { guildTextChannels: Set<string> }).guildTextChannels];
    expect(channels(scoped)).toEqual(['1500000000000000001']);
    expect(channels(empty)).toEqual([]);
    await scoped.stop();
    await empty.stop();
  });
});
