// Discord bot — Gateway + REST.
//
// We don't hit real Discord. The WebSocket is mocked (class sim with
// scripted onopen/onmessage/onclose sequencing), and the REST fetch
// is stubbed so we can assert the exact calls that went out. Tests
// focus on the identify-after-hello handshake, message dispatch
// routing (allowlist + DM-only), and the streaming edit-in-place
// contract — i.e. the places bugs would cost real users.

import { describe, test, expect, mock } from 'bun:test';
import { DiscordBot, splitForDiscord } from '../src/discord';
import { createIntakeStore, maybeHandleDiscordIntakeMessage } from '../src/intake-plane/index.js';

// ── Mock WebSocket that lets us script server frames. ────────────

class MockWs {
  static instances: MockWs[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null = null;
  readyState = 0; // CONNECTING
  sent: unknown[] = [];

  constructor(public readonly url: string) {
    MockWs.instances.push(this);
    // Defer open so tests can attach handlers first.
    setTimeout(() => {
      this.readyState = 1; // OPEN
      this.onopen?.({});
    }, 0);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(code = 1000, reason = ''): void {
    this.readyState = 3; // CLOSED
    this.onclose?.({ code, reason });
  }

  /** Helper for tests to simulate a gateway-sent frame. */
  fire(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

// ── Mock fetch that records REST calls and returns canned JSON. ──

interface RestCall { url: string; method: string; body: any }

function makeStubFetch(responder: (call: RestCall) => unknown): {
  fetchImpl: typeof fetch;
  calls: RestCall[];
} {
  const calls: RestCall[] = [];
  const fetchImpl: any = async (url: string, init: any) => {
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    const call: RestCall = { url, method: init?.method ?? 'GET', body };
    calls.push(call);
    const result = responder(call);
    return {
      ok: true,
      status: init?.method === 'PATCH' ? 200 : (result ? 200 : 204),
      json: async () => result ?? {},
      text: async () => '',
    };
  };
  return { fetchImpl, calls };
}

describe('splitForDiscord', () => {
  test('returns input when ≤ max', () => {
    expect(splitForDiscord('short', 2000)).toEqual(['short']);
  });

  test('splits at paragraph boundary when available', () => {
    const a = 'a'.repeat(1000);
    const b = 'b'.repeat(1000);
    const out = splitForDiscord(`${a}\n\n${b}`, 1500);
    expect(out.length).toBe(2);
    expect(out[0]).toBe(a);
    expect(out[1]).toBe(b);
  });

  test('hard-slices oversized single line as last resort', () => {
    const out = splitForDiscord('z'.repeat(6000), 2000);
    expect(out.length).toBeGreaterThan(1);
    expect(out.every(c => c.length > 0 && c.length <= 2000)).toBe(true);
    expect(out.join('').replace(/\s/g, '')).toBe('z'.repeat(6000));
  });
});

describe('DiscordBot', () => {
  test('REST getMe uses Bot <token> auth + /users/@me', async () => {
    const { fetchImpl, calls } = makeStubFetch(() => ({ id: '1', username: 'test' }));
    const bot = new DiscordBot({
      token: 'xyz', allowedUsers: [], onMessage: async () => undefined, fetchImpl,
    });
    const me = await bot.getMe();
    expect(me.username).toBe('test');
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe('https://discord.com/api/v10/users/@me');
    expect(calls[0]!.method).toBe('GET');
  });

  test('sendMessage chunks oversized text into multiple POSTs', async () => {
    const { fetchImpl, calls } = makeStubFetch(() => ({ id: 'msg' }));
    const bot = new DiscordBot({
      token: 'xyz', allowedUsers: [], onMessage: async () => undefined,
      fetchImpl, maxMessageChars: 100,
    });
    const big = 'x'.repeat(350);
    const out = await bot.sendMessage('CH', big);
    expect(out?.id).toBe('msg');
    expect(calls.filter(c => c.method === 'POST').length).toBeGreaterThan(1);
  });

  test('sendAudioAttachment uses multipart upload with Bot auth', async () => {
    const calls: Array<{ url: string; method: string; body: unknown; auth?: string | null }> = [];
    const fetchImpl: any = async (url: string, init: any) => {
      calls.push({
        url,
        method: init?.method ?? 'GET',
        body: init?.body,
        auth: init?.headers?.Authorization ?? null,
      });
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: 'voice-msg' }),
        text: async () => '',
      };
    };
    const bot = new DiscordBot({
      token: 'xyz', allowedUsers: [], onMessage: async () => undefined, fetchImpl,
    });
    const out = await bot.sendAudioAttachment('CH', Buffer.from('OGGDATA'), {
      filename: 'reply.ogg',
      contentType: 'audio/ogg',
    });
    expect(out?.id).toBe('voice-msg');
    expect(calls.length).toBe(1);
    expect(calls[0]?.url).toBe('https://discord.com/api/v10/channels/CH/messages');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.auth).toBe('Bot xyz');
    expect(calls[0]?.body).toBeInstanceOf(FormData);
  });

  // PLAN-multi-surface-pty-shell M2 — Discord FileSink flavor.
  test('fileSinkForChannel — sendImage posts a png multipart, fire-and-forget', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl: any = async (url: string, init: any) => {
      calls.push({ url, body: init?.body });
      return { ok: true, status: 200, json: async () => ({ id: 'img-msg' }), text: async () => '' };
    };
    const bot = new DiscordBot({
      token: 'xyz', allowedUsers: [], onMessage: async () => undefined, fetchImpl,
    });
    const sink = bot.fileSinkForChannel('CH');
    sink.sendImage!(Buffer.from('PNGDATA'), { caption: 'screen' });
    await new Promise(r => setTimeout(r, 0)); // fire-and-forget flush
    expect(calls.length).toBe(1);
    expect(calls[0]?.url).toBe('https://discord.com/api/v10/channels/CH/messages');
    const fd = calls[0]?.body as FormData;
    expect(fd).toBeInstanceOf(FormData);
    expect((fd.get('files[0]') as File).name).toBe('screen.png');
    expect((fd.get('files[0]') as File).type).toBe('image/png');
    expect(JSON.parse(fd.get('payload_json') as string)).toEqual({ content: 'screen' });
  });

  test('fileSinkForChannel — sendFile spills a text body; errors never throw', async () => {
    const calls: Array<{ body: unknown }> = [];
    let fail = false;
    const fetchImpl: any = async (_url: string, init: any) => {
      calls.push({ body: init?.body });
      if (fail) return { ok: false, status: 500, json: async () => null, text: async () => 'boom' };
      return { ok: true, status: 200, json: async () => ({ id: 'file-msg' }), text: async () => '' };
    };
    const bot = new DiscordBot({
      token: 'xyz', allowedUsers: [], onMessage: async () => undefined, fetchImpl,
    });
    const sink = bot.fileSinkForChannel('CH');
    sink.sendFile('diff body', { ext: 'diff', name: 'Edit-foo.ts.diff' });
    await new Promise(r => setTimeout(r, 0));
    const fd = calls[0]?.body as FormData;
    expect((fd.get('files[0]') as File).name).toBe('Edit-foo.ts.diff');
    // REST failure is swallowed (logged), not thrown
    fail = true;
    expect(() => sink.sendFile('x', { ext: 'txt' })).not.toThrow();
    await new Promise(r => setTimeout(r, 0));
  });

  test('gateway handshake — HELLO triggers IDENTIFY', async () => {
    MockWs.instances.length = 0;
    const { fetchImpl } = makeStubFetch(() => ({ id: 'msg' }));
    const bot = new DiscordBot({
      token: 'xyz', allowedUsers: [], onMessage: async () => undefined,
      fetchImpl, wsImpl: MockWs as any,
    });
    const p = bot.start();
    // Let the mock "open".
    await new Promise(r => setTimeout(r, 5));
    const ws = MockWs.instances[0]!;
    expect(ws.url).toContain('gateway.discord.gg');
    // Server → HELLO.
    ws.fire({ op: 10, d: { heartbeat_interval: 41250 } });
    // Our IDENTIFY should follow in the sent-queue.
    const identify = (ws.sent as any[]).find(m => m.op === 2);
    expect(identify).toBeDefined();
    expect(identify.d.token).toBe('xyz');
    // Intent bitfield includes DIRECT_MESSAGES (1<<12=4096) and
    // MESSAGE_CONTENT (1<<15=32768).
    expect(identify.d.intents & (1 << 12)).toBeTruthy();
    expect(identify.d.intents & (1 << 15)).toBeTruthy();
    bot.stop();
    ws.close();
    await p;
  });

  test('reaction emoji start and completion stay on without a config switch', async () => {
    for (const fails of [false, true]) {
      MockWs.instances.length = 0;
      const { fetchImpl, calls } = makeStubFetch((call) => {
        if (call.url.endsWith('/users/@me')) return { id: 'bot', username: 'b' };
        if (call.method === 'POST' && call.url.includes('/messages')) return { id: 'new-msg' };
        return {};
      });
      const bot = new DiscordBot({
        token: 'xyz', allowedUsers: ['user-42'],
        onMessage: async () => { if (fails) throw new Error('oops'); return 'ok'; },
        fetchImpl, wsImpl: MockWs as any,
      });
      const p = bot.start();
      await new Promise(r => setTimeout(r, 5));
      const ws = MockWs.instances[0]!;
      ws.fire({ op: 10, d: { heartbeat_interval: 41250 } });
      ws.fire({ op: 0, t: 'MESSAGE_CREATE', s: 1, d: {
        id: 'm1', channel_id: 'C1', content: 'hello', author: { id: 'user-42', username: 'alice', bot: false },
      } });
      await new Promise(r => setTimeout(r, 50));
      bot.stop();
      ws.close();
      await p;
      const emojis = calls.filter(c => c.method === 'PUT' && c.url.includes('/reactions/')).map(c => decodeURIComponent(c.url.split('/reactions/')[1]!.split('/')[0]!));
      expect(emojis).toEqual(['👀', fails ? '❌' : '✅']);
    }
  });

  test('DM from allowed user posts placeholder + routes reply to onMessage', async () => {
    MockWs.instances.length = 0;
    const { fetchImpl, calls } = makeStubFetch((call) => {
      if (call.url.endsWith('/users/@me')) return { id: 'bot', username: 'b' };
      if (call.method === 'POST' && call.url.includes('/messages')) return { id: 'new-msg' };
      return {};
    });
    const received: { text: string; channelId: string }[] = [];
    const bot = new DiscordBot({
      token: 'xyz', allowedUsers: ['user-42'],
      onMessage: async (ctx) => {
        received.push({ text: ctx.text, channelId: ctx.channelId });
        return `echo: ${ctx.text}`;
      },
      fetchImpl, wsImpl: MockWs as any,
    });
    const p = bot.start();
    await new Promise(r => setTimeout(r, 5));
    const ws = MockWs.instances[0]!;
    ws.fire({ op: 10, d: { heartbeat_interval: 41250 } });
    ws.fire({
      op: 0,
      t: 'MESSAGE_CREATE',
      s: 1,
      d: {
        id: 'm1',
        channel_id: 'C1',
        content: 'hello',
        author: { id: 'user-42', username: 'alice', bot: false },
      },
    });
    // Let async handling settle.
    await new Promise(r => setTimeout(r, 50));
    bot.stop();
    ws.close();
    await p;

    expect(received.length).toBe(1);
    expect(received[0]!.text).toBe('hello');
    expect(received[0]!.channelId).toBe('C1');
    // First POST is the `⏳ Working…` placeholder, later calls
    // replace it with the echo reply. Either sendMessage or PATCH
    // editMessage is fine for the "final" — we just need both to
    // have happened.
    const posts = calls.filter(c => c.method === 'POST' && c.url.includes('/messages'));
    const edits = calls.filter(c => c.method === 'PATCH' && c.url.includes('/messages/'));
    expect(posts.length).toBeGreaterThan(0);
    expect(posts[0]!.body.content).toBe('⏳ Working…');
    const finalContent = edits.length > 0
      ? edits[edits.length - 1]!.body.content
      : posts[posts.length - 1]!.body.content;
    expect(finalContent).toContain('echo: hello');
  });

  // 2026-07-12 — multi-chunk replies carry (i/N) continuation markers
  // so a middle chunk (which can end on a relay marker / mid-block)
  // doesn't read as a finished-but-unsigned reply.
  test('long reply chunks get (i/N) continuation markers', async () => {
    MockWs.instances.length = 0;
    const posts: string[] = [];
    const edits: string[] = [];
    const fetchImpl: any = async (url: string, init: any) => {
      const body = init?.body ? JSON.parse(init.body) : {};
      if (init?.method === 'POST') posts.push(body.content ?? '');
      if (init?.method === 'PATCH') edits.push(body.content ?? '');
      return { ok: true, status: 200, json: async () => ({ id: `m${posts.length}` }), text: async () => '' };
    };
    const longReply = Array.from({ length: 12 }, (_, i) => `line-${i} 0123456789`).join('\n');
    const bot = new DiscordBot({
      token: 'xyz', allowedUsers: ['user-42'],
      onMessage: async () => longReply,
      maxMessageChars: 80,
      fetchImpl, wsImpl: MockWs as any,
    });
    const p = bot.start();
    await new Promise(r => setTimeout(r, 5));
    const ws = MockWs.instances[0]!;
    ws.fire({ op: 10, d: { heartbeat_interval: 41250 } });
    ws.fire({
      op: 0, t: 'MESSAGE_CREATE', s: 1,
      d: { id: 'm1', channel_id: 'C1', content: 'go', author: { id: 'user-42', username: 'a', bot: false } },
    });
    await new Promise(r => setTimeout(r, 50));
    bot.stop();
    ws.close();
    await p;
    // First chunk lands as the placeholder edit; the rest as new posts.
    const finalEdit = edits[edits.length - 1] ?? '';
    expect(finalEdit).toMatch(/\(1\/\d+\) ⏬$/);
    const continuation = posts.filter(c => /\(\d+\/\d+\)/.test(c));
    expect(continuation.length).toBeGreaterThan(0);
    const last = continuation[continuation.length - 1]!;
    expect(last).toMatch(/\((\d+)\/\1\)$/); // (N/N) closes the set
    // every annotated chunk stays within the discord cap
    for (const c of [finalEdit, ...continuation]) expect(c.length).toBeLessThanOrEqual(80);
  });

  // PLAN-multi-surface-pty-shell M4a-0 — guildTextChannels scope: the
  // DM-only gate opens for designated guild text channels only (the
  // `discord-test` runner scopes itself to discord.testChannel.channelId).
  test('guildTextChannels: scoped guild channel reaches onMessage, others stay gated', async () => {
    MockWs.instances.length = 0;
    const { fetchImpl } = makeStubFetch(() => ({ id: 'msg' }));
    const received: string[] = [];
    const bot = new DiscordBot({
      token: 'xyz', allowedUsers: ['user-42'],
      guildTextChannels: ['TESTCH'],
      onMessage: async (ctx) => { received.push(ctx.channelId); return 'ok'; },
      fetchImpl, wsImpl: MockWs as any,
    });
    const p = bot.start();
    await new Promise(r => setTimeout(r, 5));
    const ws = MockWs.instances[0]!;
    ws.fire({ op: 10, d: { heartbeat_interval: 41250 } });
    const guildMsg = (channelId: string, id: string) => ({
      op: 0, t: 'MESSAGE_CREATE', s: 1,
      d: {
        id, channel_id: channelId, guild_id: 'G1', content: 'hi',
        author: { id: 'user-42', username: 'alice', bot: false },
      },
    });
    ws.fire(guildMsg('TESTCH', 'm1'));   // scoped → flows
    ws.fire(guildMsg('OTHERCH', 'm2'));  // unscoped guild → gated (기존 무변)
    await new Promise(r => setTimeout(r, 50));
    bot.stop();
    ws.close();
    await p;
    expect(received).toEqual(['TESTCH']);
  });

  test('DM from non-allowlisted user gets refusal message', async () => {
    MockWs.instances.length = 0;
    const { fetchImpl, calls } = makeStubFetch(() => ({ id: 'msg' }));
    let onMessageCalled = false;
    const bot = new DiscordBot({
      token: 'xyz', allowedUsers: ['user-42'],
      onMessage: async () => { onMessageCalled = true; return 'nope'; },
      fetchImpl, wsImpl: MockWs as any,
    });
    const p = bot.start();
    await new Promise(r => setTimeout(r, 5));
    const ws = MockWs.instances[0]!;
    ws.fire({ op: 10, d: { heartbeat_interval: 41250 } });
    ws.fire({
      op: 0, t: 'MESSAGE_CREATE', s: 1,
      d: {
        id: 'm1', channel_id: 'C1', content: 'hi',
        author: { id: 'STRANGER', username: 'bob', bot: false },
      },
    });
    await new Promise(r => setTimeout(r, 20));
    bot.stop();
    ws.close();
    await p;

    expect(onMessageCalled).toBe(false);
    const posts = calls.filter(c => c.method === 'POST');
    expect(posts[0]!.body.content).toMatch(/private/i);
  });

  test('guild message (non-DM) is ignored in DM-only v1', async () => {
    MockWs.instances.length = 0;
    const { fetchImpl, calls } = makeStubFetch(() => ({ id: 'msg' }));
    let onMessageCalled = false;
    const bot = new DiscordBot({
      token: 'xyz', allowedUsers: ['user-42'],
      onMessage: async () => { onMessageCalled = true; return 'echo'; },
      fetchImpl, wsImpl: MockWs as any,
    });
    const p = bot.start();
    await new Promise(r => setTimeout(r, 5));
    const ws = MockWs.instances[0]!;
    ws.fire({ op: 10, d: { heartbeat_interval: 41250 } });
    ws.fire({
      op: 0, t: 'MESSAGE_CREATE', s: 1,
      d: {
        id: 'm1', channel_id: 'C1', guild_id: 'G1', content: 'hi',
        author: { id: 'user-42', username: 'alice', bot: false },
      },
    });
    await new Promise(r => setTimeout(r, 20));
    bot.stop();
    ws.close();
    await p;

    expect(onMessageCalled).toBe(false);
    // No placeholder posted either — we drop the event silently.
    expect(calls.every(c => !c.url.includes('/messages'))).toBe(true);
  });

  test('DM intake shorthand resolves the latest clarify intake through the discord gateway loop', async () => {
    MockWs.instances.length = 0;
    const { fetchImpl, calls } = makeStubFetch(() => ({ id: 'msg' }));
    const store = createIntakeStore({ archiveDir: null });
    const bot = new DiscordBot({
      token: 'xyz',
      allowedUsers: ['user-42'],
      onMessage: async (ctx) => maybeHandleDiscordIntakeMessage(
        {
          text: ctx.text,
          channelId: ctx.channelId,
          userId: ctx.userId,
          userName: ctx.userName,
          attachments: ctx.attachments.map((attachment, index) => ({
            id: String(index),
            filename: attachment.filename ?? `attachment-${index}`,
            size: attachment.size ?? 0,
            url: attachment.url ?? '',
            ...(attachment.contentType ? { contentType: attachment.contentType } : {}),
            ...(attachment.width ? { width: attachment.width } : {}),
            ...(attachment.height ? { height: attachment.height } : {}),
          })),
        },
        {
          store,
          now: () => new Date('2026-04-30T12:00:00.000Z'),
          createIntakeId: () => 'intake-discord-live',
          downloadAttachment: async () => ({ localPath: '/tmp/x', fileName: 'x' }),
        },
      ),
      fetchImpl,
      wsImpl: MockWs as any,
    });
    const p = bot.start();
    await new Promise(r => setTimeout(r, 5));
    const ws = MockWs.instances[0]!;
    ws.fire({ op: 10, d: { heartbeat_interval: 41250 } });
    ws.fire({
      op: 0,
      t: 'MESSAGE_CREATE',
      s: 1,
      d: {
        id: 'm1',
        channel_id: 'C1',
        content: '!intake ====',
        author: { id: 'user-42', username: 'alice', bot: false },
      },
    });
    ws.fire({
      op: 0,
      t: 'MESSAGE_CREATE',
      s: 2,
      d: {
        id: 'm2',
        channel_id: 'C1',
        content: '!intake answer keep this in backlog',
        author: { id: 'user-42', username: 'alice', bot: false },
      },
    });
    await new Promise(r => setTimeout(r, 60));
    bot.stop();
    ws.close();
    await p;

    const posts = calls.filter(c => c.method === 'POST' && c.url.includes('/messages'));
    const edits = calls.filter(c => c.method === 'PATCH' && c.url.includes('/messages/'));
    const finalBodies = [
      ...posts.map((c) => c.body?.content).filter(Boolean),
      ...edits.map((c) => c.body?.content).filter(Boolean),
    ];
    expect(finalBodies.some((text) => String(text).includes('!intake answer <answer...>'))).toBe(true);
    expect(finalBodies.some((text) => String(text).includes('backlog-only'))).toBe(true);
  });

  test('4004 close code (bad token) stops the bot without reconnect loop', async () => {
    MockWs.instances.length = 0;
    const { fetchImpl } = makeStubFetch(() => ({}));
    const logs: string[] = [];
    const bot = new DiscordBot({
      token: 'xyz', allowedUsers: [], onMessage: async () => undefined,
      fetchImpl, wsImpl: MockWs as any,
      log: (m) => logs.push(m),
    });
    const p = bot.start();
    await new Promise(r => setTimeout(r, 5));
    const ws = MockWs.instances[0]!;
    // Gateway 4004 = Authentication failed. The bot should stop
    // the reconnect loop so a bad token doesn't spin hot; it
    // logs + resolves start() cleanly rather than throwing.
    ws.close(4004, 'Authentication failed');
    await p;
    // One connection attempt only — no reconnect means the mock
    // registry stays at size 1 even if we wait longer.
    await new Promise(r => setTimeout(r, 50));
    expect(MockWs.instances.length).toBe(1);
    expect(logs.some(l => /4004|authentication/i.test(l))).toBe(true);
  });
});
