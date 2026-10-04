import { describe, expect, spyOn, test } from 'bun:test';
import { FEATURE_MATURITY } from './feature-maturity.js';
import { botCommandVisible, filterBotCommands, readBotAudience } from './bot-command-maturity.js';
import { defaultTelegramCommands, parseTelegramSlash } from '../telegram-commands.js';
import { TelegramBot } from '../telegram.js';
import { ELANOUS_SLASH_COMMANDS, buildDiscordSlashWire } from '../discord-slash-wire.js';
import { SLASH_COMMANDS } from '../chat/index.js';
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
const stableTg = 'help status new clear reset ping provider sessions fork resume decisions work cancel'.split(' ');
const betaTg = 'skills skill digest intake ad taste missions attach detach now loops project wish'.split(' ');
const stableDc = 'status sessions new fork'.split(' ');
const betaDc = 'persona poll attach now'.split(' ');

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
    for (const name of 'cc_clear coo cto cmo cxo mission_del bots bot screen chart routines botsay'.split(' '))
      expect(FEATURE_MATURITY.telegramCommand[name as keyof typeof FEATURE_MATURITY.telegramCommand]).toBe('system');
    expect(Object.keys(FEATURE_MATURITY.discordCommand).sort()).toEqual(names(dc).sort());
    expect(stableTg).toHaveLength(13);
    for (const name of stableTg) expect(FEATURE_MATURITY.telegramCommand[name as keyof typeof FEATURE_MATURITY.telegramCommand]).toBe('stable');
    for (const name of betaTg) expect(FEATURE_MATURITY.telegramCommand[name as keyof typeof FEATURE_MATURITY.telegramCommand]).toBe('beta');
    for (const name of 'brain cc cdx gem local'.split(' ')) expect(FEATURE_MATURITY.telegramCommand[name as keyof typeof FEATURE_MATURITY.telegramCommand]).toBe('tool');
    expect(FEATURE_MATURITY.telegramCommand.harness).toBe('ops');
    for (const name of stableDc) expect(FEATURE_MATURITY.discordCommand[name as keyof typeof FEATURE_MATURITY.discordCommand]).toBe('stable');
    for (const name of betaDc) expect(FEATURE_MATURITY.discordCommand[name as keyof typeof FEATURE_MATURITY.discordCommand]).toBe('beta');
    for (const name of 'brain cc cdx gem'.split(' ')) expect(FEATURE_MATURITY.discordCommand[name as keyof typeof FEATURE_MATURITY.discordCommand]).toBe('tool');
    for (const name of 'relay showroom bots bot screen chart routines botsay voice-join voice-leave voice-status'.split(' '))
      expect(FEATURE_MATURITY.discordCommand[name as keyof typeof FEATURE_MATURITY.discordCommand]).toBe('ops');
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
        ? [...stableTg, ...betaTg, ...'brain cc cdx gem local'.split(' ')]
        : [...stableDc, ...betaDc, ...'brain cc cdx gem'.split(' ')];
      expect(names(contributor).sort()).toEqual(expected.sort());
      expect(names(filterBotCommands(surface, list, readBotAudience(undefined)))).toEqual(names(list));
      expect(botCommandVisible(surface, 'new-command', 'owner', { showBeta: false })).toBe(true);
      expect(botCommandVisible(surface, 'new-command', 'general', { showBeta: true })).toBe(false);
    }
    expect(parseTelegramSlash('/cc_clear', tg)).toMatchObject({ kind: 'match', cmd: { name: 'cc_clear' } });
    expect(parseTelegramSlash('/skill demo', tg)).toMatchObject({ kind: 'match', cmd: { name: 'skill' }, args: ['demo'] });
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
      expect(observed).toContainEqual({ category: 'telegram.command', event: 'menu-filtered', data: { total: tg.length, shown: 13, role: 'general', showBeta: false } });
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
      expect(body.filter((c) => c.default_member_permissions === undefined).map((c) => c.name).sort()).toEqual(['sessions', 'new', 'fork', 'attach', 'now', 'status', 'persona'].sort());
      expect(body.find((c) => c.name === 'cc')?.default_member_permissions).toBe('0');
      expect(observed).toContainEqual({ category: 'discord.command', event: 'menu-filtered', data: { total: expectedNames.length, shown: 7, role: 'general', showBeta: true } });
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
        expect(body.filter((c) => c.default_member_permissions === undefined).map((c) => c.name).sort()).toEqual(['status', 'persona', 'poll', 'fork', 'now'].sort());
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
        expect(body.find((c) => c.name === 'relay')?.default_member_permissions).toBe('0');
        expect(observed).toContainEqual({ category: 'discord.command', event: 'menu-filtered', data: { total: expectedNames.length, shown: 5, role: 'general', showBeta: true } });
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
