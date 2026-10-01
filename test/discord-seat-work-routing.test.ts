import { describe, expect, test } from 'bun:test';
import { DiscordBot } from '../src/discord.js';
import type { DiscordSeatWorkDeps } from '../src/intake-plane/discord-seat-work.js';

type Request = { method: string; url: string; content?: string };

function makeBot(options: {
  allowedUsers?: string[];
  guildTextChannels?: string[];
  seatWorkDeps?: DiscordSeatWorkDeps;
} = {}) {
  const requests: Request[] = [];
  const chats: string[] = [];
  const bot = new DiscordBot({
    token: 'test-token',
    allowedUsers: options.allowedUsers ?? ['owner'],
    ...(options.guildTextChannels ? { guildTextChannels: options.guildTextChannels } : {}),
    ...(options.seatWorkDeps ? { seatWorkDeps: options.seatWorkDeps } : {}),
    onMessage: async ({ text }) => { chats.push(text); return `chat: ${text}`; },
    fetchImpl: (async (url: string, init: RequestInit) => {
      const body = init.body ? JSON.parse(String(init.body)) as { content?: string } : {};
      requests.push({ method: init.method ?? 'GET', url, ...(body.content ? { content: body.content } : {}) });
      return { ok: true, status: 200, json: async () => ({ id: 'sent' }), text: async () => '' };
    }) as typeof fetch,
  });
  const receive = (text: string, options: {
    userId?: string;
    channelId?: string;
    guildId?: string;
    threadId?: string;
  } = {}) => (bot as unknown as {
    handleMessageCreate: (message: Record<string, unknown>) => Promise<void>;
  }).handleMessageCreate({
    id: 'message-1', channel_id: options.channelId ?? 'channel-1', content: text,
    author: { id: options.userId ?? 'owner' },
    ...(options.guildId ? { guild_id: options.guildId } : {}),
    ...(options.threadId ? { thread_id: options.threadId } : {}),
  });
  return { receive, requests, chats };
}

describe('Discord seat-work message routing', () => {
  test('allowlisted owner submits addressed guild work and receives its number in the originating channel', async () => {
    const submissions: unknown[] = [];
    const bot = makeBot({ seatWorkDeps: {
      submit: async (input) => {
        submissions.push(input);
        return { ok: true, track: 'graph', acceptanceId: 'R-42' };
      },
    } });
    await bot.receive('@cmo 작성해', { guildId: 'guild-1' });
    expect(submissions).toEqual([{
      text: '@CMO 작성해', track: 'graph', origin: {
        kind: 'external', ledgerSource: 'memo', provider: 'other',
        ref: 'discord:channel-1:message-1', reportTo: { channel: 'discord', channelId: 'channel-1' },
      },
    }]);
    expect(bot.requests).toEqual([{
      method: 'POST', url: 'https://discord.com/api/v10/channels/channel-1/messages',
      content: '@CMO 접수번호: R-42',
    }]);
    expect(bot.chats).toEqual([]);
  });

  test('origin thread receives both acknowledgment and report-to address', async () => {
    const submissions: unknown[] = [];
    const bot = makeBot({ seatWorkDeps: {
      submit: async (input) => {
        submissions.push(input);
        return { ok: true, track: 'graph', acceptanceId: 'R-43' };
      },
    } });
    await bot.receive('@cmo 작성해', { guildId: 'guild-1', channelId: 'parent-1', threadId: 'thread-1' });
    expect(submissions).toMatchObject([{ origin: {
      ref: 'discord:thread-1:message-1',
      reportTo: { channel: 'discord', channelId: 'thread-1', discordThreadId: 'thread-1' },
    } }]);
    expect(bot.requests).toEqual([{
      method: 'POST', url: 'https://discord.com/api/v10/channels/thread-1/messages',
      content: '@CMO 접수번호: R-43',
    }]);
    expect(bot.chats).toEqual([]);
  });

  test('unknown seat asks for clarification in the same thread without submitting or chatting', async () => {
    let submits = 0;
    const bot = makeBot({ seatWorkDeps: {
      submit: async () => { submits++; return { ok: true, track: 'graph', acceptanceId: 'R-1' }; },
    } });
    await bot.receive('@missing 작성해', { guildId: 'guild-1', channelId: 'parent-1', threadId: 'thread-1' });
    expect(submits).toBe(0);
    expect(bot.chats).toEqual([]);
    expect(bot.requests).toHaveLength(1);
    expect(bot.requests[0]?.url).toBe('https://discord.com/api/v10/channels/thread-1/messages');
    expect(bot.requests[0]?.content).toContain('좌석을 확인해 다시 보내');
  });

  test('no seat address preserves ordinary chat, placeholder, edit and reactions', async () => {
    let submits = 0;
    const bot = makeBot({ seatWorkDeps: {
      submit: async () => { submits++; return { ok: true, track: 'graph', acceptanceId: 'R-1' }; },
    } });
    await bot.receive('안녕 @cmo');
    expect(submits).toBe(0);
    expect(bot.chats).toEqual(['안녕 @cmo']);
    expect(bot.requests.map(({ method, content }) => ({ method, content }))).toEqual([
      { method: 'PUT', content: undefined },
      { method: 'POST', content: '⏳ Working…' },
      { method: 'PATCH', content: 'chat: 안녕 @cmo' },
      { method: 'PUT', content: undefined },
    ]);
  });

  test('guild chat without a seat address remains gated, and unlisted users cannot submit', async () => {
    let submits = 0;
    const bot = makeBot({ seatWorkDeps: {
      submit: async () => { submits++; return { ok: true, track: 'graph', acceptanceId: 'R-1' }; },
    } });
    await bot.receive('안녕', { guildId: 'guild-1' });
    await bot.receive('@cmo 작성해', { guildId: 'guild-1', userId: 'stranger' });
    expect(submits).toBe(0);
    expect(bot.chats).toEqual([]);
    expect(bot.requests).toEqual([]);
  });
});
