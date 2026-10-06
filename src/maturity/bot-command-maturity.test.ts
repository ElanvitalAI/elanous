import { describe, expect, spyOn, test } from 'bun:test';
import { FEATURE_MATURITY } from './feature-maturity.js';
import { botCommandVisible, filterBotCommands, readBotAudience } from './bot-command-maturity.js';
import { buildUnknownSlashReply, defaultTelegramCommands, dispatchTelegramSlash, parseTelegramSlash } from '../telegram-commands.js';
import { TelegramBot } from '../telegram.js';
import { ELANOUS_SLASH_COMMANDS, buildDiscordSlashWire } from '../discord-slash-wire.js';
import { SLASH_COMMANDS } from '../chat/index.js';
import { deriveTuiSlashAvailability } from './tui-slash-availability.js';
import { botCommands } from '../discord/slash-commands/bots.js';
import { personaCommand } from '../discord/slash-commands/persona.js';
import { pollCommand } from '../discord/slash-commands/poll.js';
import { relayCommand } from '../discord/slash-commands/relay.js';
import { showroomCommand } from '../discord/slash-commands/showroom.js';
import { statusCommand } from '../discord/slash-commands/status.js';
import { debug } from '../debug/log.js';
import { getUserConfig, setUserConfigOverlay } from '../user-config.js';
import { wireSprint21Runtime } from '../discord/sprint21-runtime.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tg = defaultTelegramCommands();
const dc = [...ELANOUS_SLASH_COMMANDS, ...[personaCommand, pollCommand, relayCommand, showroomCommand, statusCommand, ...botCommands].map((c) => c.schema)];
const names = (items: readonly { name: string }[]) => items.map((item) => item.name);
const expectedDiscordNames = (handled: readonly { name: string }[]) => {
  const registered = names(handled);
  return [...registered, ...SLASH_COMMANDS
    .filter(({ name }) => Object.hasOwn(FEATURE_MATURITY.discordCommand, name) && !registered.includes(name))
    .map(({ name }) => name)];
};
const sprintHandled = [showroomCommand, personaCommand, relayCommand, statusCommand, pollCommand, ...botCommands].map((command) => command.schema);
const byGrade = (surface: 'telegram' | 'discord', list: readonly { name: string }[], grades: readonly string[]) => {
  const maturity: Readonly<Record<string, string>> = FEATURE_MATURITY[`${surface}Command`];
  return list.filter(({ name }) => grades.includes(maturity[name] ?? '')).map(({ name }) => name);
};
const stableTg = byGrade('telegram', tg, ['stable']);
const betaTg = byGrade('telegram', tg, ['beta']);
const stableDc = byGrade('discord', dc, ['stable']);
const betaDc = byGrade('discord', dc, ['beta']);

function audienceConfig(surface: 'telegram' | 'discord', role: 'owner' | 'contributor' | 'general', showBeta = false) {
  const cfg = getUserConfig();
  return { ...cfg, raw: { ...cfg.raw, [surface]: { commandAudience: { role, showBeta } } } } as typeof cfg;
}

function response(body: unknown): Response {
  return { ok: true, json: async () => body } as Response;
}

describe('MAT1d bot menu grades', () => {
  test('all defined Telegram and both Discord registration sets are graded, with no unregistered grades', () => {
    expect(new Set(names(tg)).size).toBe(tg.length);
    expect(new Set(names(dc)).size).toBe(dc.length);
    expect(names(tg).filter((name) => !Object.hasOwn(FEATURE_MATURITY.telegramCommand, name))).toEqual([]);
    expect(Object.keys(FEATURE_MATURITY.telegramCommand).sort()).toEqual(names(tg).sort());
    expect(Object.keys(FEATURE_MATURITY.discordCommand).sort()).toEqual(names(dc).sort());
    // Safety pins stay by hand: owner-only commands must never drift into a general menu by a grade-table edit.
    for (const name of 'cc_clear mission_del botsay'.split(' ')) expect(FEATURE_MATURITY.telegramCommand[name as keyof typeof FEATURE_MATURITY.telegramCommand]).toBe('system');
    expect(FEATURE_MATURITY.telegramCommand.harness).toBe('ops');
    for (const name of 'relay botsay voice-join'.split(' ')) expect(FEATURE_MATURITY.discordCommand[name as keyof typeof FEATURE_MATURITY.discordCommand]).toBe('ops');
    for (const surface of ['telegram', 'discord'] as const) {
      const list = surface === 'telegram' ? tg : dc;
      const grades: Readonly<Record<string, string>> = FEATURE_MATURITY[`${surface}Command`];
      expect(byGrade(surface, list, ['stable', 'beta', 'tool', 'ops', 'system']).sort()).toEqual(names(list).sort());
      for (const name of names(list)) expect(grades[name]).toBeDefined();
      for (const entry of deriveTuiSlashAvailability()) {
        expect(entry[surface]).toBe(Object.hasOwn(FEATURE_MATURITY[`${surface}Command`], entry.name));
      }
    }
  });

  test('invalid config defaults owner, and visibility changes only the menu', () => {
    for (const raw of [undefined, null, [], {}, { role: 'unknown', showBeta: 'true' }])
      expect(readBotAudience(raw)).toEqual({ role: 'owner', showBeta: false });
    expect(readBotAudience({ role: 'general', showBeta: true })).toEqual({ role: 'general', showBeta: true });
    expect(readBotAudience({ role: 'contributor' })).toEqual({ role: 'contributor', showBeta: false });
    expect(names(filterBotCommands('telegram', tg, { role: 'general', showBeta: false }))).toEqual(stableTg);
    expect(names(filterBotCommands('telegram', tg, { role: 'general', showBeta: true })).sort()).toEqual([...stableTg, ...betaTg].sort());
    expect(names(filterBotCommands('discord', dc, { role: 'general', showBeta: false })).sort()).toEqual(stableDc.sort());
    expect(names(filterBotCommands('discord', dc, { role: 'general', showBeta: true })).sort()).toEqual([...stableDc, ...betaDc].sort());
    for (const surface of ['telegram', 'discord'] as const) {
      const list: readonly { name: string }[] = surface === 'telegram' ? tg : dc;
      const contributor = filterBotCommands(surface, list, { role: 'contributor', showBeta: false });
      const expected = surface === 'telegram'
        ? byGrade('telegram', tg, ['stable', 'beta', 'tool'])
        : byGrade('discord', dc, ['stable', 'beta', 'tool']);
      expect(names(contributor).sort()).toEqual(expected.sort());
      expect(names(filterBotCommands(surface, list, readBotAudience(undefined)))).toEqual(names(list));
      expect(botCommandVisible(surface, 'new-command', 'owner', { showBeta: false })).toBe(true);
      expect(botCommandVisible(surface, 'new-command', 'general', { showBeta: true })).toBe(false);
    }
    expect(parseTelegramSlash('/cc_clear', tg)).toMatchObject({ kind: 'match', cmd: { name: 'cc_clear' } });
    expect(parseTelegramSlash('/skill demo', tg)).toMatchObject({ kind: 'match', cmd: { name: 'skill' }, args: ['demo'] });
  });

  test('Telegram replies on TUI-only commands and keeps supported and unknown dispatch unchanged', async () => {
    const commands = [{ name: 'ping', description: 'ping', handler: async () => 'pong' }];
    const opts = { allCommands: commands, userConfig: audienceConfig('telegram', 'general') };
    const ctx = (text: string) => ({ text, chatId: 1, userId: 1, messageId: 1, attachments: [], isDm: true } as unknown as Parameters<typeof dispatchTelegramSlash>[0]);
    expect(await dispatchTelegramSlash(ctx('/model'), opts)).toEqual({ handled: true, reply: '/model은(는) 텔레그램에서 아직 지원되지 않습니다. TUI에서 /model을(를) 사용하세요.' });
    expect(buildUnknownSlashReply('run-skill', commands)).toBe('/run-skill은(는) 텔레그램에서 아직 지원되지 않습니다. TUI에서 /run-skill을(를) 사용하세요.');
    expect(await dispatchTelegramSlash(ctx('/ping'), opts)).toEqual({ handled: true, reply: 'pong' });
    expect(await dispatchTelegramSlash(ctx('hello'), opts)).toEqual({ handled: false });
    expect(buildUnknownSlashReply('mystery', commands)).toContain('Unknown command: /mystery');
    expect(buildUnknownSlashReply('system-only', commands)).toContain('Unknown command: /system-only');
  });

  test('Telegram publishes only general commands, logs totals, yet retains hidden slash parsing', async () => {
    const calls: { method: string; body: any }[] = [];
    const fetchImpl = (async (url: string, opts: RequestInit) => {
      const method = url.split('/').pop()!;
      calls.push({ method, body: JSON.parse(String(opts.body)) });
      if (method === 'getUpdates') { bot.stop(); return response({ ok: true, result: [] }); }
      return response({ ok: true, result: true });
    }) as typeof fetch;
    const observed: Array<{ category: string; event: string; data: unknown }> = [];
    const spy = spyOn(debug, 'log').mockImplementation((category: string, event: string, data?: unknown) => { observed.push({ category, event, data }); });
    const bot = new TelegramBot({ token: '123:fake', allowedUsers: [1], onMessage: async () => '', fetchImpl, slashCommands: tg, slashContext: { userConfig: audienceConfig('telegram', 'general') } });
    try {
      await bot.start();
      expect(calls.find((c) => c.method === 'setMyCommands')?.body.commands.map((c: { command: string }) => c.command)).toEqual(stableTg);
      // The general menu itself never shows an owner-only command (not just «equals the derived list»).
      for (const name of 'cc_clear mission_del botsay harness'.split(' ')) expect(calls.find((c) => c.method === 'setMyCommands')?.body.commands.map((c: { command: string }) => c.command)).not.toContain(name);
      expect(observed).toContainEqual({ category: 'telegram.command', event: 'menu-filtered', data: { total: tg.length, shown: stableTg.length, role: 'general', showBeta: false } });
      expect(parseTelegramSlash('/harness task', tg)).toMatchObject({ kind: 'match', cmd: { name: 'harness' } });
      expect(names(filterBotCommands('telegram', [...tg, { name: 'future-command', description: 'new', handler: async () => '' }], { role: 'owner', showBeta: false }))).toHaveLength(tg.length + 1);
    } finally { spy.mockRestore(); bot.stop(); }
  });

  test('Discord guild bulk overwrite keeps every schema registered and makes hidden ones admin-only', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith('/applications/@me')) return response({ id: 'app' });
      if (url.endsWith('/users/@me/guilds')) return response([{ id: 'guild' }]);
      return response([]);
    }) as typeof fetch;
    const observed: Array<{ category: string; event: string; data: unknown }> = [];
    const spy = spyOn(debug, 'log').mockImplementation((category: string, event: string, data?: unknown) => { observed.push({ category, event, data }); });
    try {
      const wire = buildDiscordSlashWire({ userConfig: { ...audienceConfig('discord', 'general', true), discord: { ...getUserConfig().discord, botToken: 'fake' } }, allowedUsers: [], handleMessage: async () => '', getBot: () => null, __fetchImpl: fetchImpl });
      await wire.registerCommands();
      const put = calls.find((c) => c.init?.method === 'PUT');
      expect(put?.url).toContain('/guilds/guild/commands');
      const body = JSON.parse(String(put?.init?.body)) as Array<{ name: string; default_member_permissions?: string }>;
      // Unregistered Discord slash commands cannot be called at all, so hidden ones stay registered (review round 2).
      const expectedNames = expectedDiscordNames(ELANOUS_SLASH_COMMANDS);
      expect(body.map((c) => c.name)).toEqual(expectedNames);
      expect(new Set(expectedNames).size).toBe(expectedNames.length);
      expect(body.filter((c) => c.default_member_permissions === undefined).map((c) => c.name).sort())
        .toEqual(byGrade('discord', body, ['stable', 'beta']).sort());
      expect(body.find((c) => c.name === 'cc')?.default_member_permissions).toBe('0');
      expect(observed).toContainEqual({ category: 'discord.command', event: 'menu-filtered', data: { total: expectedNames.length, shown: byGrade('discord', body, ['stable', 'beta']).length, role: 'general', showBeta: true } });
    } finally { spy.mockRestore(); }
  });

  test('sprint21 guild and global registration keep every schema and gate hidden ones', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mat1d-personas-'));
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return response([]);
    }) as typeof fetch;
    const observed: Array<{ category: string; event: string; data: unknown }> = [];
    const spy = spyOn(debug, 'log').mockImplementation((category: string, event: string, data?: unknown) => { observed.push({ category, event, data }); });
    setUserConfigOverlay((cfg) => ({ ...cfg, raw: { ...cfg.raw, discord: { commandAudience: { role: 'general', showBeta: true } } } }));
    try {
      const strategies: string[] = [];
      const runtime = await wireSprint21Runtime({ bot: {} as any, token: 'fake', appId: 'app', personasDir: dir, watchPersonas: false, devGuildId: 'guild', fetchImpl,
        setChannelStrategy: async (_channelId, strategy) => { strategies.push(strategy); },
        spawnLanes: async (request) => ({ message: `spawned ${request.tokens.length} lanes` }),
      });
      try {
        expect(await runtime.registerSlashCommands()).toBe(0);
        const put = calls.find((c) => c.url.includes('/guilds/guild/commands'))!;
        const body = JSON.parse(String(put.init?.body)) as Array<{ name: string; default_member_permissions?: string }>;
        const expectedNames = expectedDiscordNames(sprintHandled);
        expect(body.map((c) => c.name)).toEqual(expectedNames);
        expect(new Set(expectedNames).size).toBe(expectedNames.length);
        expect(body.filter((c) => c.default_member_permissions === undefined).map((c) => c.name).sort())
          .toEqual(byGrade('discord', body, ['stable', 'beta']).sort());
        const interaction = (commandName: string, options: ReadonlyMap<string, string | number | boolean> = new Map()) =>
          ({ id: 'i', token: 't', applicationId: 'app', commandName, channelId: 'guild', userId: 'u', options });
        const status = await runtime.router.dispatchToBody(interaction('status'));
        expect(status).toMatchObject({ data: { content: expect.stringContaining('elanous status') } });
        const relay = await runtime.router.dispatchToBody(interaction('relay', new Map([['strategy', 'mention-only']])));
        expect(relay).toMatchObject({ data: { content: '✅ strategy set to `mention-only`' } });
        expect(strategies).toEqual(['mention-only']);
        const showroom = await runtime.router.dispatchToBody(interaction('showroom', new Map([['lanes', 'plan:claude']])));
        expect(showroom).toMatchObject({ data: { content: 'spawned 1 lanes' } });
        const fallback = await runtime.router.dispatchToBody(interaction('fork'));
        const fallbackContent = (fallback.data as { content: string }).content;
        expect(fallbackContent).toContain('/fork은(는) 디스코드에서 아직 지원되지 않습니다.');
        expect(fallbackContent.includes('\n')).toBe(false);
        expect((await runtime.router.dispatchToBody(interaction('status'))).data).toMatchObject({ content: expect.stringContaining('elanous status') });
        expect(body.find((c) => c.name === 'relay')?.default_member_permissions).toBe('0');
        expect(observed).toContainEqual({ category: 'discord.command', event: 'menu-filtered', data: { total: expectedNames.length, shown: byGrade('discord', body, ['stable', 'beta']).length, role: 'general', showBeta: true } });
        expect(runtime.router.schemas().some((schema) => schema.name === 'relay')).toBe(true);
        calls.length = 0;
        setUserConfigOverlay((cfg) => ({ ...cfg, raw: { ...cfg.raw, discord: { commandAudience: { role: 'owner', showBeta: false } } } }));
        const ownerRuntime = await wireSprint21Runtime({ bot: {} as any, token: 'fake', appId: 'app', personasDir: dir, watchPersonas: false, fetchImpl });
        try {
          await ownerRuntime.registerSlashCommands();
          const global = calls.find((c) => c.url.endsWith('/applications/app/commands'))!;
          expect(names(JSON.parse(String(global.init?.body)) as Array<{ name: string }>)).toEqual(expectedNames);
        } finally { ownerRuntime.shutdown(); }
      } finally { runtime.shutdown(); }
    } finally { setUserConfigOverlay(null); spy.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
  });
});
