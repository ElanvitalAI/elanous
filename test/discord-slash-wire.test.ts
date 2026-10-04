// C3 (2026-07-12) — 네이티브 슬래시 wire 테스트: 명령 합성 매핑,
// 인터랙션 ACK/allowlist/채널스코프, 합성 문장→파이프라인 합류, 등록 REST.

import { describe, expect, test } from 'bun:test';
import {
  buildDiscordSlashWire,
  discordWireCatalog,
  synthesizeCommandText,
  ELANOUS_SLASH_COMMANDS,
} from '../src/discord-slash-wire.js';
import { SLASH_COMMANDS } from '../src/chat/index.js';
import { FEATURE_MATURITY } from '../src/maturity/feature-maturity.js';
import type { DcIncoming } from '../src/discord.js';
import type { UserConfig } from '../src/user-config.js';

const cfg = { discord: { botToken: 'tok' } } as unknown as UserConfig;

function makeInteraction(name: string, options: Array<{ name: string; value: string | number }> = [], over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 2, id: 'i1', token: 'itok', application_id: 'app1', channel_id: 'CH1',
    guild_id: 'G1', member: { user: { id: 'u-allowed', username: 'boss' } },
    data: { type: 1, name, options },
    ...over,
  };
}

describe('synthesizeCommandText', () => {
  test('maps slash commands onto the existing text-command grammar', () => {
    expect(synthesizeCommandText('cc', new Map([['prompt', '빌드 고쳐줘']]))).toBe('!cc 빌드 고쳐줘');
    expect(synthesizeCommandText('brain', new Map())).toBe('!brain');
    expect(synthesizeCommandText('sessions', new Map())).toBe('!sessions');
    expect(synthesizeCommandText('attach', new Map([['prefix', 'abc123']]))).toBe('!attach abc123');
    expect(synthesizeCommandText('fork', new Map())).toBe('!fork');
    expect(synthesizeCommandText('fork', new Map<string, string | number>([['prefix', 'abc'], ['before', 2]]))).toBe('!fork abc before:2');
    expect(synthesizeCommandText('voice-join', new Map())).toBe('!voice-join');
    expect(synthesizeCommandText('voice-join', new Map([['channel', 'VC9']]))).toBe('!voice-join VC9');
  });
});

describe('buildDiscordSlashWire.onInteraction', () => {
  function makeWire(over: Partial<Parameters<typeof buildDiscordSlashWire>[0]> = {}) {
    const acks: Array<{ url: string; body: unknown }> = [];
    const handled: DcIncoming[] = [];
    const sent: Array<{ channelId: string; text: string }> = [];
    const fakeFetch = (async (url: string, init?: { body?: string }) => {
      if (String(url).includes('/callback')) {
        acks.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
        return { ok: true, status: 204, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    }) as unknown as typeof fetch;
    const wire = buildDiscordSlashWire({
      userConfig: cfg,
      handleMessage: async (ctx) => { handled.push(ctx); return '파이프라인 응답'; },
      getBot: () => ({ sendMessage: async (channelId: string, text: string) => { sent.push({ channelId, text }); return { id: 'm1' }; } }) as never,
      allowedUsers: ['u-allowed'],
      __fetchImpl: fakeFetch,
      ...over,
    });
    return { wire, acks, handled, sent };
  }

  test('allowed user: acks, synthesizes text, routes through pipeline, sends reply', async () => {
    const { wire, acks, handled, sent } = makeWire();
    await wire.onInteraction(makeInteraction('cc', [{ name: 'prompt', value: '테스트 돌려줘' }]));
    expect(acks).toHaveLength(1);
    expect((acks[0]!.body as { data: { content: string } }).data.content).toContain('!cc 테스트 돌려줘');
    expect(handled).toHaveLength(1);
    expect(handled[0]!.text).toBe('!cc 테스트 돌려줘');
    expect(handled[0]!.channelId).toBe('CH1');
    expect((handled[0]!.raw as { guild_id?: string }).guild_id).toBe('G1');
    expect(sent).toEqual([{ channelId: 'CH1', text: '파이프라인 응답' }]);
  });

  test('only unhandled catalog commands receive a one-line reply, after authorization', async () => {
    const { wire, acks, handled, sent } = makeWire();
    for (const name of ELANOUS_SLASH_COMMANDS.map((schema) => schema.name)) {
      await wire.onInteraction(makeInteraction(name));
    }
    expect(handled.map((ctx) => ctx.text)).toEqual(ELANOUS_SLASH_COMMANDS.map((schema) => synthesizeCommandText(schema.name, new Map())));
    expect(sent).toHaveLength(ELANOUS_SLASH_COMMANDS.length);
    for (const name of ['status', 'relay', 'showroom', 'persona']) {
      await wire.onInteraction(makeInteraction(name));
      const reply = (acks.at(-1)!.body as { data: { content: string } }).data.content;
      expect(reply).toBe(discordWireCatalog().unsupportedReply(name)!);
      expect(reply.includes('\n')).toBe(false);
    }
    expect(handled).toHaveLength(ELANOUS_SLASH_COMMANDS.length);
    await wire.onInteraction(makeInteraction('status', [], { member: { user: { id: 'stranger' } } }));
    expect((acks.at(-1)!.body as { data: { content: string } }).data.content).toContain('⛔');
  });

  test('non-allowlisted user is refused at the interaction layer', async () => {
    const { wire, acks, handled } = makeWire();
    await wire.onInteraction(makeInteraction('cc', [{ name: 'prompt', value: 'x' }], {
      member: { user: { id: 'u-stranger', username: 'x' } },
    }));
    expect(handled).toHaveLength(0);
    expect((acks[0]!.body as { data: { content: string } }).data.content).toContain('⛔');
  });

  test('channelScope rejects interactions from other channels', async () => {
    const { wire, handled, acks } = makeWire({ channelScope: 'ONLY' });
    await wire.onInteraction(makeInteraction('sessions'));
    expect(handled).toHaveLength(0);
    expect((acks[0]!.body as { data: { content: string } }).data.content).toContain('ONLY');
  });

  test('non-slash payloads (components, pings) are ignored silently', async () => {
    const { wire, acks, handled } = makeWire();
    await wire.onInteraction({ type: 3, id: 'x', token: 't' });
    expect(acks).toHaveLength(0);
    expect(handled).toHaveLength(0);
  });
});

describe('registerCommands', () => {
  test('bulk-overwrites the command set per guild', async () => {
    const puts: Array<{ url: string; body: unknown }> = [];
    const fakeFetch = (async (url: string, init?: { method?: string; body?: string }) => {
      const u = String(url);
      if (u.endsWith('/applications/@me')) return { ok: true, status: 200, json: async () => ({ id: 'app9' }) };
      if (u.endsWith('/users/@me/guilds')) return { ok: true, status: 200, json: async () => [{ id: 'G7' }] };
      if (init?.method === 'PUT') {
        puts.push({ url: u, body: JSON.parse(init.body ?? '[]') });
        return { ok: true, status: 200, json: async () => (JSON.parse(init.body ?? '[]') as unknown[]).map((c, i) => ({ id: `c${i}`, ...(c as object) })) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    }) as unknown as typeof fetch;
    const wire = buildDiscordSlashWire({
      userConfig: cfg,
      handleMessage: async () => undefined,
      getBot: () => null,
      allowedUsers: [],
      __fetchImpl: fakeFetch,
    });
    await wire.registerCommands();
    expect(puts).toHaveLength(1);
    expect(puts[0]!.url).toContain('/applications/app9/guilds/G7/commands');
    const handledNames = ELANOUS_SLASH_COMMANDS.map((schema) => schema.name);
    const coreNames = SLASH_COMMANDS
      .filter(({ name }) => Object.hasOwn(FEATURE_MATURITY.discordCommand, name) && !handledNames.includes(name))
      .map(({ name }) => name);
    const putBody = puts[0]!.body as Array<Record<string, unknown> & { name: string }>;
    const names = putBody.map((c) => c.name);
    expect(names).toEqual([...handledNames, ...coreNames]);
    for (const command of putBody) expect(command).not.toHaveProperty('supported');
    for (const name of coreNames) {
      expect(putBody.find((command) => command.name === name)).toMatchObject({
        name, description: discordWireCatalog().commands.find((entry) => entry.name === name)!.description,
      });
    }
    expect(names).toHaveLength(new Set(names).size);
    expect((puts[0]!.body as Array<{ name: string; options?: unknown }>).find((c) => c.name === 'cc')?.options).toEqual(ELANOUS_SLASH_COMMANDS.find((c) => c.name === 'cc')?.options);
    expect(handledNames).toContain('cc');
    expect(handledNames).toContain('fork');
    expect(handledNames).toContain('voice-join');
    expect(coreNames).toEqual(['status', 'persona', 'showroom', 'relay']);
  });
});

describe('C3+ — slash ATTACHMENT option (/cc file:이미지)', () => {
  test('resolved attachments land on the synthetic ctx (C2 경로로 합류)', async () => {
    const handled: DcIncoming[] = [];
    const acks: unknown[] = [];
    const fakeFetch = (async (url: string, init?: { body?: string }) => {
      if (String(url).includes('/callback')) acks.push(init?.body ? JSON.parse(init.body) : null);
      return { ok: true, status: 204, json: async () => ({}) };
    }) as unknown as typeof fetch;
    const wire = buildDiscordSlashWire({
      userConfig: cfg,
      handleMessage: async (ctx) => { handled.push(ctx); return undefined; },
      getBot: () => null,
      allowedUsers: ['u-allowed'],
      __fetchImpl: fakeFetch,
    });
    await wire.onInteraction(makeInteraction('cc',
      [{ name: 'prompt', value: '이 스샷 검토' }, { name: 'file', value: 'att-1' }],
      { data: { type: 1, name: 'cc',
        options: [{ name: 'prompt', value: '이 스샷 검토' }, { name: 'file', value: 'att-1' }],
        resolved: { attachments: { 'att-1': {
          id: 'att-1', filename: 'shot.png', size: 999,
          url: 'https://cdn.discordapp.com/x/shot.png', content_type: 'image/png',
          width: 640, height: 480,
        } } },
      } },
    ));
    expect(handled).toHaveLength(1);
    expect(handled[0]!.text).toBe('!cc 이 스샷 검토'); // 첨부 id는 프롬프트에 안 샘
    expect(handled[0]!.attachments).toEqual([{
      id: 'att-1', filename: 'shot.png', size: 999,
      url: 'https://cdn.discordapp.com/x/shot.png', contentType: 'image/png',
      width: 640, height: 480,
    }]);
    expect(JSON.stringify(acks[0])).toContain('첨부 1');
  });
});
