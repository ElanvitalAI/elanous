import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDiscordSelfOnMessage } from './discord-self-message.js';
import { contextNow, type ContextNowDeps } from './context-bus/context-now.js';
import { renderTelegramNow } from './context-bus/context-now-surfaces.js';
import type { DcIncoming, DiscordBot } from './discord.js';
import { getUserConfig, type UserConfig } from './user-config.js';
import type { runTurn } from './session/chat.js';

const at = '2026-10-06T00:00:00.000Z';
const nowDeps: ContextNowDeps = {
  now: () => new Date(at), version: () => '0.2.16',
  checklist: version => ({ version, released: '', dev: version, history: [], items: [] }),
  decisions: () => [], seatEntries: () => [], events: () => [],
};
const summary = renderTelegramNow(contextNow({}, nowDeps));
const incoming = (text: string, channelId = 'dm'): DcIncoming => ({
  channelId, userId: 'owner', text, messageId: '1', isDm: true, attachments: [], raw: {},
});

function makeHandler(options: { contextFirst?: boolean; failRead?: boolean; failSend?: boolean } = {}) {
  let time = 0;
  const sent: string[] = [];
  const config = { llm: { provider: 'test' }, discord: { contextFirst: options.contextFirst } } as unknown as UserConfig;
  const bot = { sendMessage: async (_channelId: string, text: string) => {
    if (options.failSend) throw Error('delivery down');
    sent.push(text);
    return { id: 'summary' };
  }, fileSinkForChannel: () => ({}) } as unknown as DiscordBot;
  const runTurnImpl = (async () => {
    sent.push('본 답');
    return { text: '본 답' };
  }) as unknown as typeof runTurn;
  const handler = buildDiscordSelfOnMessage({
    userConfig: config, getBot: () => bot, runTurnImpl,
    contextFirstNow: () => time,
    nowDeps: options.failRead ? { ...nowDeps, version: () => { throw Error('ledger down'); } } : nowDeps,
    tuiSlashAvailability: [],
  });
  return { handler, sent, advance: (ms: number) => { time += ms; } };
}

test('first Discord DM sends one summary before the normal reply; five minutes later sends none; seven hours later sends one', async () => {
  const { handler, sent, advance } = makeHandler();
  expect(await handler(incoming('안녕'))).toBe('본 답');
  expect(sent).toEqual([summary, '본 답']);
  advance(5 * 60_000);
  sent.length = 0;
  expect(await handler(incoming('또'))).toBe('본 답');
  expect(sent).toEqual(['본 답']);
  advance(7 * 60 * 60_000);
  sent.length = 0;
  expect(await handler(incoming('나중'))).toBe('본 답');
  expect(sent).toEqual([summary, '본 답']);
});

test('Discord /now reply remains the same, while a command updates the idle clock without consuming the pending summary', async () => {
  const { handler, sent, advance } = makeHandler();
  expect(await handler(incoming('/now'))).toBe(summary);
  expect(sent).toEqual([]);
  advance(5 * 60_000);
  expect(await handler(incoming('안녕'))).toBe('본 답');
  expect(sent).toEqual([summary, '본 답']);
  advance(5 * 60 * 60_000);
  expect(await handler(incoming('/now'))).toBe(summary);
  advance(2 * 60 * 60_000);
  sent.length = 0;
  expect(await handler(incoming('다시'))).toBe('본 답');
  expect(sent).toEqual(['본 답']);
});

test('Discord config persists only explicit false for contextFirst', () => {
  const dir = mkdtempSync(join(tmpdir(), 'discord-context-first-'));
  try {
    const path = join(dir, 'config.json');
    for (const [raw, expected] of [[false, false], [true, undefined], ['false', undefined]] as const) {
      writeFileSync(path, JSON.stringify({ discord: { contextFirst: raw } }));
      expect(getUserConfig(path).discord.contextFirst).toBe(expected);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('discord.contextFirst false suppresses the summary', async () => {
  const { handler, sent } = makeHandler({ contextFirst: false });
  expect(await handler(incoming('안녕'))).toBe('본 답');
  expect(sent).toEqual(['본 답']);
});

test('failed context reading yields the unreadable message before the normal reply', async () => {
  const { handler, sent } = makeHandler({ failRead: true });
  expect(await handler(incoming('안녕'))).toBe('본 답');
  expect(sent).toEqual(['맥락 못 읽음', '본 답']);
});

test('failed summary delivery does not block the normal reply', async () => {
  const { handler, sent } = makeHandler({ failSend: true });
  expect(await handler(incoming('안녕'))).toBe('본 답');
  expect(sent).toEqual(['본 답']);
});
