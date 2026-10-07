import { expect, test } from 'bun:test';
import { buildDiscordSelfOnMessage } from './discord-self-message.js';
import { discordWireCatalog, ELANOUS_SLASH_COMMANDS, synthesizeCommandText } from './discord-slash-wire.js';
import { telegramLoopsStatus, type LoopsSources } from './telegram-loops-command.js';
import type { LoopSchedule } from './loops/status-rows.js';
import type { DcIncoming } from './discord.js';
import type { UserConfig } from './user-config.js';
import type { runTurn } from './session/chat.js';

const now = Date.parse('2026-10-04T12:00:00Z');
const schedule = (id: string, lastRun: LoopSchedule['lastRun']): LoopSchedule => ({
  id, name: id, source: 'crontab', category: 'monitor', domain: 'ops',
  runVia: 'crontab', cron: null, intervalMs: 600_000, state: 'live', next: [], lastRun,
});
const sources: LoopsSources = {
  schedules: () => ({ schedules: [
    schedule('late', { at: '2026-10-04T11:40:00Z', status: 'ok', exit: 0 }),
    schedule('failed', { at: '2026-10-04T11:59:00Z', status: 'error', exit: 1 }),
    schedule('alive-1', { at: '2026-10-04T11:59:00Z', status: 'ok', exit: 0 }),
    schedule('alive-2', { at: '2026-10-04T11:59:00Z', status: 'ok', exit: 0 }),
  ] }),
  loops: () => ({ loops: { loops: [] } }),
  now: () => now + 1,
};
const config = { llm: { provider: 'test' } } as unknown as UserConfig;
let modelCalls = 0;
const noModelTurn = (async () => {
  modelCalls++;
  throw new Error('loops must not start an LLM turn');
}) as typeof runTurn;
const incoming = (text: string): DcIncoming => ({
  channelId: 'channel', userId: 'owner', text, messageId: '1', isDm: true, attachments: [], raw: {},
});
const handler = (loopsSources: LoopsSources = sources) => buildDiscordSelfOnMessage({
  userConfig: config, runTurnImpl: noModelTurn, getBot: () => null, loopsSources,
});

test('Discord /loops renders the exact Telegram result from one source with late before failed and two alive', async () => {
  const expected = await telegramLoopsStatus([], sources);
  expect(expected.split('\n').filter(line => line.startsWith('• '))).toHaveLength(2);
  expect(expected.indexOf('늦음 · late')).toBeLessThan(expected.indexOf('실패 · failed'));
  expect(expected.split('\n').at(-1)).toBe('살아 있음 2 · 꺼짐 0 · 판정 불가 0');
  for (const text of ['/loops', '!loops', synthesizeCommandText('loops', new Map())]) {
    expect(await handler()(incoming(text))).toBe(expected);
  }
});

test('Discord /loops reports the Telegram source failure reply', async () => {
  const broken: LoopsSources = { ...sources, schedules: () => { throw new Error('offline'); } };
  expect(await handler(broken)(incoming('/loops'))).toBe('루프 현황 못 읽음');
});

test('Discord /loops with arguments returns Telegram usage', async () => {
  expect(await handler()(incoming('/loops x'))).toBe('사용법: /loops');
});

test('Discord /loops and its invalid arguments never start an LLM turn', async () => {
  modelCalls = 0;
  const onMessage = handler();
  await onMessage(incoming('/loops'));
  await onMessage(incoming('!loops'));
  await onMessage(incoming('/loops x'));
  expect(modelCalls).toBe(0);
});

test('Discord registers an optionless native /loops with a supported beta catalog entry', () => {
  expect(ELANOUS_SLASH_COMMANDS.find(command => command.name === 'loops')).toEqual({
    name: 'loops', description: '루프·크론 현황 (늦음·실패 먼저)',
  });
  expect(discordWireCatalog().commands.find(command => command.name === 'loops')?.supported).toBe(true);
  expect(discordWireCatalog().unsupportedReply('loops')).toBeNull();
  expect(synthesizeCommandText('loops', new Map())).toBe('!loops');
});
