import { expect, test } from 'bun:test';
import { buildDiscordSelfOnMessage } from './discord-self-message.js';
import { buildDiscordSlashWire, ELANOUS_SLASH_COMMANDS, synthesizeCommandText } from './discord-slash-wire.js';
import { contextNow, type ContextNowDeps } from './context-bus/context-now.js';
import { renderTelegramNow } from './context-bus/context-now-surfaces.js';
import type { DcIncoming, DiscordBot } from './discord.js';
import type { UserConfig } from './user-config.js';
import type { runTurn } from './session/chat.js';

const at = '2026-10-03T04:00:00.000Z';
const nowDeps: ContextNowDeps = {
  now: () => new Date(at), version: () => '0.2.0',
  checklist: version => ({ version, released: '', dev: version, history: [], items: version === '0.2.0' ? [
    { id: 'K6', title: 'Context door', status: 'red', updatedAt: at, updatedBy: 'TC' },
    { id: 'K7', title: 'Unrelated work', status: 'yellow', updatedAt: at, updatedBy: 'TC' },
  ] : [] }),
  decisions: () => [{ id: 'D1', title: 'Release review', status: 'open', raisedBy: { agent: 'TC' },
    category: 'scope', scqa: { s: 'SECRET CONVERSATION', c: 'x' }, options: [], recommendation: { skipped: true, reason: 'x' }, history: [] }],
  seatEntries: () => [{ entry: { seat: 'TC', at, status: 'shadow', item: { source: 'checklist', id: 'K6', title: 'Context door', text: 'SECRET CONVERSATION' } }, source: 'elanous://seat-loop/TC/1#1' }],
  events: () => [{ id: 'a', at, kind: '보고', summary: 'K6 ready', text: 'SECRET CONVERSATION', refs: { seat: 'TC', recipients: [], all: false, kind: '보고', slot: null, deadline: null, url: 'https://example.org/context' } }],
};
const config = { llm: { provider: 'test' } } as unknown as UserConfig;
const noModelTurn = (async () => { throw new Error('now must not start an LLM turn'); }) as typeof runTurn;
const handler = buildDiscordSelfOnMessage({ userConfig: config, runTurnImpl: noModelTurn, getBot: () => null, nowDeps });
const incoming = (text: string): DcIncoming => ({ channelId: 'channel', userId: 'owner', text, messageId: '1', isDm: true, attachments: [], raw: {} });

test('Discord registers native /now with an optional topic and synthesizes the text route', () => {
  const schema = ELANOUS_SLASH_COMMANDS.find(command => command.name === 'now');
  expect(schema).toEqual({ name: 'now', description: '지금 판·칸·결정·자리·최근 맥락 보기', options: [
    { name: 'topic', description: '좁혀 볼 주제 (선택)', type: 3, required: false },
  ] });
  expect(synthesizeCommandText('now', new Map())).toBe('!now');
  expect(synthesizeCommandText('now', new Map([['topic', ' Context door ']]))).toBe('!now Context door');
});

test('Discord native /now interaction acknowledges and posts the shared ledger view in the originating channel', async () => {
  const callbacks: Array<{ url: string; body: unknown }> = [];
  const posts: Array<{ channelId: string; text: string }> = [];
  const wire = buildDiscordSlashWire({
    userConfig: config,
    allowedUsers: ['owner'],
    handleMessage: handler,
    getBot: () => ({ sendMessage: async (channelId: string, text: string) => {
      posts.push({ channelId, text });
      return { id: 'posted' };
    } }) as DiscordBot,
    __fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      callbacks.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response('', { status: 204 });
    }) as typeof fetch,
  });
  await wire.onInteraction({
    type: 2, id: 'interaction', token: 'token', application_id: 'app', channel_id: 'channel', user: { id: 'owner' },
    data: { type: 1, name: 'now', options: [{ name: 'topic', value: 'Context door' }] },
  });
  expect(callbacks).toEqual([{ url: 'https://discord.com/api/v10/interactions/interaction/token/callback',
    body: { type: 4, data: { content: '▶ `!now Context door`' } } }]);
  expect(posts).toEqual([{ channelId: 'channel', text: renderTelegramNow(contextNow({ topic: 'Context door' }, nowDeps)) }]);
});

test('Discord /now reads the same sourced public facts as Telegram without invoking the LLM', async () => {
  const expected = renderTelegramNow(contextNow({}, nowDeps));
  for (const text of ['/now', '!now', synthesizeCommandText('now', new Map())]) {
    expect(await handler(incoming(text))).toBe(expected);
  }
  expect(expected).toContain('K6 Context door');
  expect(expected).toContain('D1 Release review');
  expect(expected).toContain('https://example.org/context');
  expect(expected).not.toContain('SECRET CONVERSATION');
});

test('Discord /now topic filters the same ledger view and leaves unrelated commands alone', async () => {
  const text = synthesizeCommandText('now', new Map([['topic', 'Context door']]));
  const reply = await handler(incoming(text));
  expect(reply).toBe(renderTelegramNow(contextNow({ topic: 'Context door' }, nowDeps)));
  expect(reply).toContain('K6');
  expect(reply).not.toContain('K7');
  expect(reply).not.toContain('SECRET CONVERSATION');
  expect(await handler(incoming('/now Context door'))).toBe(reply);
  expect(await handler(incoming('!notnow'))).toBe('⚠️ turn failed: now must not start an LLM turn');
});
