import { expect, test } from 'bun:test';
import { defaultTelegramCommands, dispatchTelegramSlash, parseTelegramSlash, toTelegramBotCommands, type TgCommandContext } from './telegram-commands.js';
import type { TgIncoming } from './telegram.js';
import { telegramLoopsStatus } from './telegram-loops-command.js';
import { FEATURE_MATURITY } from './maturity/feature-maturity.js';
import { loadLoopRows, LOOP_SCHEDULES_PATH, LOOPS_PATH, type LoopSchedule } from './loops/status-rows.js';

const now = Date.parse('2026-10-04T12:00:00Z');
const schedule = (patch: Partial<LoopSchedule> = {}): LoopSchedule => ({
  id: 'cron-1', name: 'heartbeat', source: 'crontab', category: 'monitor', domain: 'ops',
  runVia: 'crontab', cron: null, intervalMs: 600_000, state: 'live', next: [],
  lastRun: { at: '2026-10-04T11:40:00Z', status: 'ok', exit: 0 }, ...patch,
});
const inventory = {
  schedules: () => ({ schedules: [
    schedule(),
    schedule({ id: 'cron-off', name: 'off-job', state: 'off' }),
    schedule({ id: 'cron-fail', name: 'failed-job', lastRun: { at: '2026-10-04T11:59:00Z', status: 'error', exit: 1 } }),
    schedule({ id: 'cron-unknown', name: 'unknown-job', lastRun: null, intervalMs: null }),
    schedule({ id: 'cron-calendar', name: 'calendar-job', cron: '*/10 9 * * *', intervalMs: null, state: 'live' }),
    schedule({ id: 'cron-stale', name: 'stale-job', cron: '*/10 9 * * *', intervalMs: null, state: 'stale' }),
  ] }),
  loops: () => ({ loops: { loops: [
    { name: 'retro', label: 'retro', category: 'reflect', armed: null, last: null },
    { name: 'heartbeat', label: 'heartbeat', category: 'exec', armed: false, last: null },
  ] } }),
  now: () => now + 1,
};

test('Telegram /loops is registered, published and reports only PWA late/failed rows before the summary', async () => {
  const commands = defaultTelegramCommands();
  const parsed = parseTelegramSlash('/loops', commands);
  expect(parsed).toMatchObject({ kind: 'match', cmd: { name: 'loops' } });
  expect(toTelegramBotCommands(commands)).toContainEqual({ command: 'loops', description: '루프·크론 현황 — 늦음·실패를 먼저 보여줍니다' });
  expect(FEATURE_MATURITY.telegramCommand.loops).toBe('beta');
  expect(await dispatchTelegramSlash({ text: '/loops extra' } as TgIncoming,
    { allCommands: commands } as TgCommandContext)).toEqual({ handled: true, reply: '사용법: /loops' });
  const pwaRows = await loadLoopRows(async path => path === LOOP_SCHEDULES_PATH ? inventory.schedules() : inventory.loops(), now + 1);
  expect(pwaRows.map(row => row.verdict)).toEqual(['늦음', '꺼짐', '실패', '판정 불가', '살아 있음', '늦음', '판정 불가', '꺼짐']);
  const reply = await telegramLoopsStatus([], inventory);
  const lines = reply.split('\n');
  expect(lines[0]).toBe('루프·크론 현황');
  expect(lines.filter(line => line.startsWith('• '))).toHaveLength(3);
  for (const row of pwaRows.filter(row => row.verdict === '늦음' || row.verdict === '실패'))
    expect(reply).toContain(`${row.verdict} · ${row.name} (${row.layer})`);
  expect(reply).not.toContain('schedule:cron-off');
  expect(reply).not.toContain('schedule:cron-unknown');
  expect(reply).not.toContain('loop:heartbeat');
  expect(reply.indexOf('stale-job')).toBeLessThan(reply.indexOf('failed-job'));
  expect(lines.at(-1)).toBe('살아 있음 1 · 꺼짐 2 · 판정 불가 2');
});

test('two late, one failed and five alive schedules produce three problem rows and exact counts', async () => {
  const schedules = [
    ...Array.from({ length: 2 }, (_, i) => schedule({ id: `late-${i}`, name: `late-${i}` })),
    schedule({ id: 'failed', name: 'failed', lastRun: { at: '2026-10-04T11:59:00Z', status: 'error', exit: 1 } }),
    ...Array.from({ length: 5 }, (_, i) => schedule({ id: `alive-${i}`, name: `alive-${i}`, lastRun: { at: '2026-10-04T11:59:00Z', status: 'ok', exit: 0 } })),
  ];
  const reply = await telegramLoopsStatus([], { ...inventory, schedules: () => ({ schedules }), loops: () => ({ loops: { loops: [] } }) });
  const lines = reply.split('\n');
  expect(lines.filter(line => line.startsWith('• '))).toHaveLength(3);
  expect(lines.slice(1, 4).map(line => line.match(/(늦음|실패) ·/)?.[1])).toEqual(['늦음', '늦음', '실패']);
  expect(reply).not.toContain('alive-0');
  expect(lines.at(-1)).toBe('살아 있음 5 · 꺼짐 0 · 판정 불가 0');
});

test('only ten problem rows appear before counts, even for long inventories', async () => {
  const reply = await telegramLoopsStatus([], { ...inventory, schedules: () => ({ schedules: Array.from({ length: 150 }, (_, i) =>
    schedule({ id: `job-${i}`, name: `job-${i}-${'x'.repeat(70)}` })) }), loops: () => ({ loops: { loops: [] } }) });
  expect(reply.length).toBeLessThan(4096);
  expect(reply.split('\n').filter(line => line.startsWith('• '))).toHaveLength(10);
  expect(reply).toContain('… 140개 더');
  expect(reply.split('\n').at(-1)).toBe('살아 있음 0 · 꺼짐 0 · 판정 불가 0');
});

test('Telegram /loops distinguishes empty, source failure, and usage', async () => {
  expect(await telegramLoopsStatus([], { ...inventory, schedules: () => ({ schedules: [] }), loops: () => ({ loops: { loops: [] } }) })).toBe('모두 정상');
  expect(await telegramLoopsStatus([], { ...inventory, schedules: () => { throw new Error('offline'); } })).toBe('루프 현황 못 읽음');
  expect(await telegramLoopsStatus([], { ...inventory, loops: () => ({ loops: null }) })).toBe('루프 현황 못 읽음');
  expect(await telegramLoopsStatus(['extra'], inventory)).toBe('사용법: /loops');
});
