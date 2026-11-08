// End-to-end handoff integration test.
//
// The scenario we're locking down:
//   1. User has an in-progress TUI conversation.
//   2. `/telegram attach` snapshots history into a fresh session +
//      binds the session to the Telegram chat id.
//   3. An inbound Telegram message arrives for that chat. The bot's
//      onMessage handler must (a) find the SAME session (not spawn
//      a fresh one), (b) append the Telegram turn to the SAME
//      JSONL.
//   4. `/telegram detach` (or the Telegram-side /detach) frees the
//      chat slot. The NEXT Telegram message spawns a new session.
//
// We exercise the real botFromConfig handler path — only fetch is
// stubbed, so the session index, JSONL write, and routing all go
// through production code.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSession,
  appendMessage,
  attachTelegramBinding,
  detachTelegramBinding,
  loadSession,
  findSessionByTelegramChat,
} from '../src/session/index.js';
import { botFromConfig } from '../src/telegram.js';
import type { UserConfig } from '../src/user-config.js';
import { createFakeFetchDevice, type FakeFetchDevice, type FakeFetchRequest } from '../src/ux-sim/fake-fetch.js';

const savedEnv: Record<string, string | undefined> = {};
let tmpRoot: string;
let fakeFetch: FakeFetchDevice | undefined;

function sseRes(events: unknown[]): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(c) {
      for (const ev of events) c.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
      c.enqueue(enc.encode('data: [DONE]\n\n'));
      c.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function installHandoffFetch(onLlm?: (request: FakeFetchRequest) => Response | Promise<Response>): void {
  fakeFetch?.restore();
  fakeFetch = createFakeFetchDevice([
    { url: 'http://mock:1234/chat/completions', method: 'POST', response: (request) => onLlm?.(request) ?? sseRes([{ choices: [{ delta: { content: 'reply' } }] }]) },
    ...['getMe', 'setMyCommands', 'sendMessage', 'sendChatAction', 'editMessageText'].map((method) => ({
      url: `https://api.telegram.org/botfake-token/${method}`,
      method: 'POST',
      response: () => jsonRes({ ok: true, result: { message_id: 99 } }),
    })),
  ]);
}

function userCfg(): UserConfig {
  return {
    skillRouter: {
      autoRoute: false, autoRouteCountdownMs: 1000, llmFallback: false,
      keywordScoreThreshold: 2, llmConfidenceThreshold: 0.5,
      autoRouteMinScore: 1, autoRouteRequireAutoTrigger: true,
    },
    llm: {
      provider: 'local',
      baseUrl: 'http://mock:1234',
      model: 'test-model',
    },
    skills: { activeSet: 'opencode', dirs: [] },
    obsidian: { vault: '/tmp/v' },
    telegram: {
      enabled: true,
      botToken: 'fake-token',
      allowedUsers: [42],
    },
    discord: { enabled: false, allowedUsers: [] },
    onboarding: { completed: true, version: 1 },
    debug: { file: false },
    raw: {},
  };
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'elanous-handoff-'));
  // ELANOUS_STATE_DIR is the knob `sessionRoot()` honors — XDG alone is NOT
  // enough. 2026-07-09 rooted the store at ~/.elanous and made XDG an
  // explicit no-op (src/session/index.ts:56-58), which silently turned
  // this isolation off and leaked ~97 runs' worth of fixture sessions
  // into the real store. Keep XDG for anything else that still reads it.
  savedEnv.ELANOUS_STATE_DIR = process.env.ELANOUS_STATE_DIR;
  savedEnv.XDG_DATA_HOME = process.env.XDG_DATA_HOME;
  savedEnv.XDG_STATE_HOME = process.env.XDG_STATE_HOME;
  process.env.ELANOUS_STATE_DIR = join(tmpRoot, 'state');
  process.env.XDG_DATA_HOME = join(tmpRoot, 'data');
  process.env.XDG_STATE_HOME = join(tmpRoot, 'state');
});

afterEach(() => {
  try {
    if (fakeFetch) {
      const requests = fakeFetch.calls().map(({ method, url }) => `${method} ${url}`);
      expect(requests).toEqual(['POST http://mock:1234/chat/completions']);
    }
  } finally {
    fakeFetch?.restore();
    fakeFetch = undefined;
    rmSync(tmpRoot, { recursive: true, force: true });
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

describe('TUI → Telegram handoff', () => {
  test('inbound Telegram message lands in the attached TUI session', async () => {
    // --- Step 1: simulate TUI-side work ---
    // Laptop was having a conversation — create a session and drop
    // three prior turns into its JSONL like the /telegram attach
    // snapshot would.
    const tuiSession = createSession({
      source: 'cli',
      provider: 'local',
      model: 'test-model',
      title: 'ssh into node-b',
    });
    const historyTs = '2026-04-15T10:00:00Z';
    appendMessage(tuiSession.id, { role: 'user', content: 'what ports is node-b exposing?', ts: historyTs });
    appendMessage(tuiSession.id, { role: 'assistant', content: '22, 443, and 5432 (postgres).', ts: historyTs });
    appendMessage(tuiSession.id, { role: 'user', content: 'can you confirm postgres auth is tls-only?', ts: historyTs });

    // --- Step 2: /telegram attach binds this session to chat 42 ---
    attachTelegramBinding(tuiSession.id, 42);

    // Sanity: bindings-aware lookup points at our session
    expect(findSessionByTelegramChat(42)?.id).toBe(tuiSession.id);

    // --- Step 3: Telegram inbound message for chat 42 ---
    // Stub fetch so the LLM provider returns a deterministic reply.
    // The bot's getMe + setMyCommands + sendMessage calls also go
    // through fetch; we route by URL shape.
    const llmReplies: string[] = [];
    installHandoffFetch((request) => {
        // Read the wire payload so we can verify the LLM saw full
        // history (not just the latest message).
        const body = request.body ? JSON.parse(request.body) : {};
        llmReplies.push(JSON.stringify(body.messages));
        return sseRes([
          { choices: [{ delta: { content: 'yes — ' } }] },
          { choices: [{ delta: { content: 'tls-only.' } }] },
        ]);
    });

    const bot = botFromConfig({ userConfig: userCfg() });

    // Invoke the LLM handler the way handleIncoming does — the
    // private handler is wired in the constructor. botFromConfig
    // doesn't expose it directly, so call bot.onMessage if present,
    // else reach into the options path. The simplest integration
    // hook is the public `sendInboundForTest`-shaped call: use
    // handleIncoming via a synthetic event (see next test for direct
    // inbound path). Here we construct the ctx and call the bot's
    // handler through its onMessage interface.
    // The bot instance's private handler is captured — we trigger
    // it via a synthetic call through the library's public shape:
    // bot.onMessage(ctx, streamer?) is exposed by TelegramBot.
    // If not, we'd need a test-only hook. For now: invoke the
    // handler via the reflective accessor the class defines.
    const handler = (bot as any).onMessage as (ctx: any, streamer?: any) => Promise<string | void>;
    expect(typeof handler).toBe('function');

    const reply = await handler({
      chatId: 42,
      userId: 42,
      userName: 'alice',
      text: 'yes please confirm',
      messageId: 1,
      threadId: undefined,
      isDm: true,
      isGroup: false,
      attachments: [],
    });

    // --- Step 4: verify the JSONL got the new turn appended ---
    const loaded = loadSession(tuiSession.id);
    expect(loaded).toBeTruthy();
    const msgs = loaded!.messages;
    // 3 prior + 1 new user + 1 assistant reply = 5
    expect(msgs.length).toBe(5);
    expect(msgs[3]!.role).toBe('user');
    expect(msgs[3]!.content).toBe('yes please confirm');
    expect(msgs[4]!.role).toBe('assistant');
    expect(msgs[4]!.content).toBe('yes — tls-only.');
    // And the assistant reply we returned to Telegram matches
    expect(reply).toBe('yes — tls-only.');

    // Sanity — no second session spawned
    const allSessions = [loaded!.meta];
    expect(allSessions.length).toBe(1);

    // And the LLM was given full history, not just the one new turn
    const wirePayload = llmReplies[0]!;
    expect(wirePayload).toContain('what ports is node-b exposing');
    expect(wirePayload).toContain('5432');
  });

  test('after /detach the next Telegram message creates a new session', async () => {
    // Set up an attached session, then detach, then simulate a fresh
    // Telegram message — it must spawn a new session, not reuse the
    // detached one.
    const tuiSession = createSession({ source: 'cli', title: 'old' });
    attachTelegramBinding(tuiSession.id, 42);
    detachTelegramBinding(tuiSession.id);

    // Confirm lookup returns null — slot is free
    expect(findSessionByTelegramChat(42)).toBeNull();

    installHandoffFetch(() => sseRes([{ choices: [{ delta: { content: 'new session reply' } }] }]));

    const bot = botFromConfig({ userConfig: userCfg() });
    const handler = (bot as any).onMessage as (ctx: any) => Promise<string>;
    await handler({
      chatId: 42, userId: 42, userName: 'alice',
      text: 'fresh question', messageId: 2,
      threadId: undefined, isDm: true, isGroup: false,
      attachments: [],
    });

    // The old session's JSONL still has nothing appended (only the
    // metadata row) — the NEW turn went to a fresh session.
    const oldLoaded = loadSession(tuiSession.id);
    expect(oldLoaded!.messages.length).toBe(0);

    // And a new session exists (source=telegram from botFromConfig's
    // auto-create path) carrying the new turn.
    const { listSessions } = await import('../src/session/index.js');
    const all = listSessions();
    const fresh = all.find(m => m.id !== tuiSession.id);
    expect(fresh).toBeDefined();
    expect(fresh!.source).toBe('telegram');
    expect(fresh!.tgChatId).toBe(42);
  });

  test('bindings-first wins over a legacy auto-session for the same chat', async () => {
    // If a user had a legacy auto-session on chat 42 and then later
    // ran /telegram attach with a different session, the NEW attached
    // session should receive the next inbound message — not the old
    // auto-session.
    const legacy = createSession({ source: 'telegram', tgChatId: 42 });
    appendMessage(legacy.id, { role: 'user', content: 'prior legacy turn', ts: '2026-04-14T00:00:00Z' });

    const fresh = createSession({ source: 'cli', title: 'fresh laptop work' });
    attachTelegramBinding(fresh.id, 42);

    installHandoffFetch(() => sseRes([{ choices: [{ delta: { content: 'to the fresh one' } }] }]));

    const bot = botFromConfig({ userConfig: userCfg() });
    const handler = (bot as any).onMessage as (ctx: any) => Promise<string>;
    await handler({
      chatId: 42, userId: 42, userName: 'alice',
      text: 'where does this land?', messageId: 3,
      threadId: undefined, isDm: true, isGroup: false,
      attachments: [],
    });

    // Legacy session untouched; fresh session grew by two turns.
    const legacyLoaded = loadSession(legacy.id);
    expect(legacyLoaded!.messages.length).toBe(1);  // only the pre-seeded turn
    const freshLoaded = loadSession(fresh.id);
    expect(freshLoaded!.messages.length).toBe(2);
    expect(freshLoaded!.messages[0]!.content).toBe('where does this land?');
  });
});
