import { describe, expect, test } from 'bun:test';
import { handleDiscordSeatWork } from './discord-seat-work.js';
import { DiscordBot } from '../discord.js';

const MSG = { channelId: '123', messageId: '456' };

describe('Discord addressed seat work', () => {
  test('leaves unaddressed chat messages untouched without submitting', async () => {
    let calls = 0;
    const reply = await handleDiscordSeatWork('일반 대화 중 @cmo 언급', MSG, {
      submit: async () => { calls++; return { ok: true, track: 'graph', acceptanceId: 'R-1' }; },
    });
    expect(reply).toBeNull();
    expect(calls).toBe(0);
  });

  test('resolves title and alias and submits each addressed seat with the Discord origin', async () => {
    const inputs: unknown[] = [];
    const reply = await handleDiscordSeatWork('@t,cTo 이번 주 블로그 초안 만들어', { ...MSG, threadId: '789' }, {
      submit: async (input) => {
        inputs.push(input);
        return { ok: true, track: 'graph', acceptanceId: `R-${inputs.length}` };
      },
    });
    expect(inputs).toEqual([
      {
        text: '@CMO 이번 주 블로그 초안 만들어', track: 'graph',
        origin: { kind: 'external', ledgerSource: 'memo', provider: 'other', ref: 'discord:123:456', reportTo: { channel: 'discord', channelId: '123', discordThreadId: '789' } },
      },
      {
        text: '@CTO 이번 주 블로그 초안 만들어', track: 'graph',
        origin: { kind: 'external', ledgerSource: 'memo', provider: 'other', ref: 'discord:123:456', reportTo: { channel: 'discord', channelId: '123', discordThreadId: '789' } },
      },
    ]);
    expect(reply).toBe('@CMO 접수번호: R-1\n@CTO 접수번호: R-2');
  });

  test('the actual intake door forwards the originating channel to the harness', async () => {
    const received: unknown[] = [];
    const reply = await handleDiscordSeatWork('@mk 구현해 줘', MSG, {
      askHarness: async (text, reportTo) => {
        received.push({ text, reportTo });
        return { acceptanceId: 'R-77' };
      },
      log: () => {},
    });
    expect(received).toEqual([{ text: '@CMO 구현해 줘', reportTo: { channel: 'discord', channelId: '123' } }]);
    expect(reply).toBe('@CMO 접수번호: R-77');
  });

  test('unknown seats ask for clarification; no partial submissions even with valid seats', async () => {
    let calls = 0;
    const reply = await handleDiscordSeatWork('@cmo,cfo 구현해 줘', MSG, {
      submit: async () => { calls++; return { ok: true, track: 'graph', acceptanceId: 'R-1' }; },
    });
    expect(reply).toContain('@cfo');
    expect(reply).toContain('좌석을 확인해 다시 보내');
    expect(calls).toBe(0);
  });

  test('empty request asks for work rather than submitting', async () => {
    let calls = 0;
    const reply = await handleDiscordSeatWork('@cmo  ', MSG, {
      submit: async () => { calls++; return { ok: true, track: 'graph', acceptanceId: 'R-1' }; },
    });
    expect(reply).toContain('요청 내용을 적어');
    expect(calls).toBe(0);
  });

  test('submission failure cannot claim an intake number', async () => {
    const reply = await handleDiscordSeatWork('@cmo 실행해', MSG, {
      submit: async () => ({ ok: false, track: 'graph', reason: 'no-acceptance-id\ninternal trace' }),
    });
    expect(reply).toBe('@CMO 접수 실패 — no-acceptance-id');
  });

  test('allowlisted gateway messages reach the intake door and reply in the originating channel', async () => {
    const posts: Array<{ url: string; content: string }> = [];
    const inputs: unknown[] = [];
    let chats = 0;
    const bot = new DiscordBot({
      token: 'tok', allowedUsers: ['owner'],
      onMessage: async () => { chats++; return 'chat'; },
      seatWorkDeps: {
        submit: async (input) => { inputs.push(input); return { ok: true, track: 'graph', acceptanceId: 'R-42' }; },
      },
      fetchImpl: (async (url: string, init: RequestInit) => {
        if (init.method === 'POST') posts.push({ url, content: JSON.parse(String(init.body)).content });
        return { ok: true, status: 200, json: async () => ({ id: 'response' }), text: async () => '' };
      }) as typeof fetch,
    });
    const receive = (m: Record<string, unknown>) => (bot as unknown as {
      handleMessageCreate: (m: Record<string, unknown>) => Promise<void>;
    }).handleMessageCreate(m);

    await receive({ author: { id: 'owner' }, id: 'm-1', channel_id: 'thread-9', thread_id: 'thread-9', content: '@cmo 작성해' });
    expect(inputs).toEqual([{ text: '@CMO 작성해', track: 'graph', origin: {
      kind: 'external', ledgerSource: 'memo', provider: 'other', ref: 'discord:thread-9:m-1',
      reportTo: { channel: 'discord', channelId: 'thread-9', discordThreadId: 'thread-9' },
    } }]);
    expect(posts).toEqual([{ url: 'https://discord.com/api/v10/channels/thread-9/messages', content: '@CMO 접수번호: R-42' }]);
    expect(chats).toBe(0);

    await receive({ author: { id: 'owner' }, id: 'm-2', channel_id: 'thread-9', content: '@unknown 작성해' });
    expect(inputs).toHaveLength(1);
    expect(posts[1]?.content).toContain('좌석을 확인해 다시 보내');
    expect(chats).toBe(0);

    await receive({ author: { id: 'owner' }, id: 'm-3', channel_id: 'thread-9', content: '일반 대화' });
    expect(inputs).toHaveLength(1);
    expect(chats).toBe(1);
    expect(posts[2]?.content).toBe('⏳ Working…');

    await receive({ author: { id: 'stranger' }, id: 'm-4', channel_id: 'thread-9', content: '@cmo 작성해' });
    expect(inputs).toHaveLength(1);
    expect(chats).toBe(1);
    expect(posts[3]?.content).toContain('not on the allowlist');
  });
});
