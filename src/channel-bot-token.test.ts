import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setElanousConfigDir, resetElanousConfigDir } from './elanous-config-dir.js';
import { getSecret, setSecret, useBackend, registerBackend, resetBackendRegistry } from './nexus/config/secrets/index.js';
import { probeChannelBotToken, resolveChannelBotToken, storeChannelBotToken } from './channel-bot-token.js';
import { defaultTelegramOrigin } from './autopilot/mission-origin.js';
import { createNexusTelegramTriggerBot } from './nexus/api/telegram-trigger-bot.js';
import { resolveReportTarget } from './telegram-report.js';
import { startTelegramPollers, setTelegramPollLockForTesting } from './telegram-run.js';
import { wireNexusTelegramQaPollers } from './nexus/index.js';
import { getUserConfig, resetUserConfig, saveUserConfig } from './user-config.js';
import type { UserConfig } from './user-config.js';

let dir: string;
const marker = 'test-credential-do-not-print-91:ABC';
const envNames = ['ELANOUS_TELEGRAM_BOT_TOKEN', 'ELANOUS_DISCORD_BOT_TOKEN'] as const;
let previous: (string | undefined)[];
let previousXdg: string | undefined;
const cfg = (platform: 'telegram' | 'discord', token: string): UserConfig => ({
  telegram: { enabled: true, allowedUsers: [], botToken: platform === 'telegram' ? token : undefined },
  discord: { enabled: true, allowedUsers: [], botToken: platform === 'discord' ? token : undefined },
}) as unknown as UserConfig;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'channel-bot-token-'));
  setElanousConfigDir(dir);
  previousXdg = process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_CONFIG_HOME;
  resetUserConfig();
  useBackend('file');
  previous = envNames.map(name => process.env[name]);
  envNames.forEach(name => { delete process.env[name]; });
});
afterEach(() => {
  envNames.forEach((name, i) => {
    if (previous[i] === undefined) delete process.env[name];
    else process.env[name] = previous[i];
  });
  resetUserConfig();
  resetBackendRegistry();
  resetElanousConfigDir();
  if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousXdg;
  rmSync(dir, { recursive: true, force: true });
});

describe('channel bot credential precedence', () => {
  for (const platform of ['telegram', 'discord'] as const) {
    test(`${platform}: tokenRef beats env and plaintext`, () => {
      const config = cfg(platform, 'plaintext');
      config.tabs = { [`${platform}:1`]: { tokenRef: 'ref:secret:canonical' } };
      setSecret('canonical', marker);
      process.env[`ELANOUS_${platform.toUpperCase()}_BOT_TOKEN`] = 'env';
      expect(resolveChannelBotToken(platform, config)).toEqual({ token: marker, source: 'tokenRef' });
    });
    test(`${platform}: env beats plaintext`, () => {
      const config = cfg(platform, 'plaintext');
      process.env[`ELANOUS_${platform.toUpperCase()}_BOT_TOKEN`] = 'env';
      expect(resolveChannelBotToken(platform, config)).toEqual({ token: 'env', source: 'env' });
    });
    test(`${platform}: plaintext-only fallback`, () => {
      expect(resolveChannelBotToken(platform, cfg(platform, marker))).toEqual({ token: marker, source: 'botToken' });
    });
  }
});

test('stale ref falls back to main channel (or the first), and emits no credential', () => {
  const config = cfg('telegram', '');
  config.tabs = { 'telegram:1': { tokenRef: 'ref:secret:missing' } };
  config.telegram.channels = [
    { name: 'other', botToken: 'first-token', chatId: 1, interactive: true, roles: [] },
    { name: 'main', botToken: marker, chatId: 2, interactive: true, roles: [] },
  ];
  expect(resolveChannelBotToken('telegram', config)).toEqual({ token: marker, source: 'channels.main' });
  config.telegram.channels = [config.telegram.channels[0]!];
  expect(resolveChannelBotToken('telegram', config)).toEqual({ token: 'first-token', source: 'channels.main' });
});

test('unresolved ref identifies id and secrets path without printing the credential', () => {
  const config = cfg('telegram', '');
  config.tabs = { 'telegram:1': { tokenRef: 'ref:secret:missing-id' } };
  expect(resolveChannelBotToken('telegram', config)).toEqual({ token: '', reason: `ref-id-missing missing-id in ${join(dir, 'secrets.json')}` });
  expect(resolveChannelBotToken('discord', cfg('discord', ''))).toEqual({ token: '', reason: 'no-source' });
  registerBackend({ id: 'keychain', get: async () => undefined, set: async () => {}, delete: async () => false,
    list: async () => [], isAvailable: async () => ({ ok: true }) });
  useBackend('keychain');
  expect(resolveChannelBotToken('telegram', config)).toEqual({ token: '', reason: 'backend keychain not sync-readable' });
});

test('store keeps unrelated keys, removes plaintext, and publishes an atomic secret reference', async () => {
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({ other: { retained: true }, telegram: { botToken: 'legacy', enabled: true } }));
  await storeChannelBotToken('telegram', marker, ['19']);
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  expect(saved.other).toEqual({ retained: true });
  expect(saved.telegram).toEqual({ enabled: true, allowedUsers: [19] });
  expect(saved.tabs['telegram:1'].tokenRef).toBe('ref:secret:telegram_1__tokenRef');
  expect(getSecret('telegram_1__tokenRef')).toBe(marker);
  expect(readdirSync(dir).sort()).toEqual(['config.json', 'secrets.json']);
  await storeChannelBotToken('telegram', 'new-token');
  expect(getSecret('telegram_1__tokenRef')).toBe('new-token');
});

test('store rejects invalid or unsafe telegram user IDs before writing config or secrets', async () => {
  const path = join(dir, 'config.json');
  const before = JSON.stringify({ telegram: { botToken: 'legacy', allowedUsers: [19] } });
  writeFileSync(path, before);
  for (const id of ['abc', '9007199254740992', '0', '-1']) {
    await expect(storeChannelBotToken('telegram', marker, [id])).rejects.toThrow('invalid-allowed-users');
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(getSecret('telegram_1__tokenRef')).toBeUndefined();
    expect(readdirSync(dir)).toEqual(['config.json']);
  }
});

test('migration selector runs while the config lock is held and publishes that snapshot', async () => {
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({ telegram: { botToken: marker } }));
  let observed = false;
  await storeChannelBotToken(config => {
    observed = true;
    expect(statSync(`${path}.lock`).isFile()).toBe(true);
    expect((config.telegram as { botToken: string }).botToken).toBe(marker);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(config);
    return [{ platform: 'telegram', token: (config.telegram as { botToken: string }).botToken }];
  }, true);
  expect(observed).toBe(true);
  expect(getSecret('telegram_1__tokenRef')).toBe(marker);
  expect(JSON.parse(readFileSync(path, 'utf8')).telegram).not.toHaveProperty('botToken');
});

test('store never overwrites a secret referenced by a different ID', async () => {
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({ telegram: { botToken: 'old' }, tabs: {
    'telegram:1': { tokenRef: 'ref:secret:shared' },
  } }));
  setSecret('shared', 'other-service-token');
  await storeChannelBotToken('telegram', marker);
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  expect(saved.tabs['telegram:1'].tokenRef).toBe('ref:secret:telegram_1__tokenRef');
  expect(saved.telegram).not.toHaveProperty('botToken');
  expect(getSecret('shared')).toBe('other-service-token');
  expect(getSecret('telegram_1__tokenRef')).toBe(marker);
});

test('probe recognizes both bot APIs and suppresses token-bearing fetch errors', async () => {
  const tg = (async (url: RequestInfo | URL) => {
    expect(String(url)).toContain(marker);
    return Response.json({ ok: true, result: { username: 'tg_bot' } });
  }) as typeof fetch;
  expect(await probeChannelBotToken('telegram', marker, tg)).toEqual({ ok: true, botName: 'tg_bot' });
  const discord = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    expect(init?.headers).toEqual({ Authorization: `Bot ${marker}` });
    return Response.json({ username: 'dc_bot' });
  }) as typeof fetch;
  expect(await probeChannelBotToken('discord', marker, discord)).toEqual({ ok: true, botName: 'dc_bot' });
  const failing = (async () => { throw new Error(`https://api.telegram.org/bot${marker}/getMe`); }) as unknown as typeof fetch;
  expect(await probeChannelBotToken('telegram', marker, failing)).toEqual({ ok: false });
});

const script = join(import.meta.dir, '../scripts/ops/channel-bot-token-migrate.ts');
function invokeWithEnv(env: Record<string, string>, ...args: string[]) {
  return Bun.spawnSync(['bun', script, '--config-dir', dir, ...args], {
    cwd: join(import.meta.dir, '..'),
    env: { ...process.env, ELANOUS_TELEGRAM_BOT_TOKEN: '', ELANOUS_DISCORD_BOT_TOKEN: '', ...env },
  });
}
function invoke(...args: string[]) {
  return invokeWithEnv({}, ...args);
}

test('dry-run leaves config and secrets untouched; apply backs up, replaces atomically and redacts output', () => {
  const path = join(dir, 'config.json');
  const raw = JSON.stringify({ version: 1, global: {}, tabs: {}, telegram: { enabled: true, botToken: marker }, discord: { enabled: true, botToken: marker } });
  writeFileSync(path, raw);
  const dry = invoke();
  expect(dry.exitCode).toBe(0);
  expect(readFileSync(path, 'utf8')).toBe(raw);
  expect(getSecret('telegram_1__tokenRef')).toBeUndefined();
  expect(getSecret('discord_1__tokenRef')).toBeUndefined();
  expect(readdirSync(dir)).toEqual(['config.json']);
  expect(dry.stdout.toString()).toContain('dry-run: telegram · action=new-ref · plaintext=present');
  expect(dry.stdout.toString()).toContain('dry-run: discord · action=new-ref · plaintext=present');
  expect(dry.stdout.toString() + dry.stderr.toString()).not.toContain(marker);
  const applied = invoke('--apply');
  expect(applied.exitCode).toBe(0);
  const text = applied.stdout.toString() + applied.stderr.toString();
  expect(text).not.toContain(marker);
  expect(text).toContain('Bot restart required');
  expect(getSecret('telegram_1__tokenRef')).toBe(marker);
  expect(getSecret('discord_1__tokenRef')).toBe(marker);
  const updated = JSON.parse(readFileSync(path, 'utf8'));
  expect(updated.telegram).not.toHaveProperty('botToken');
  expect(updated.discord).not.toHaveProperty('botToken');
  expect(updated.tabs['telegram:1'].tokenRef).toBe('ref:secret:telegram_1__tokenRef');
  expect(updated.tabs['discord:1'].tokenRef).toBe('ref:secret:discord_1__tokenRef');
  expect(resolveChannelBotToken('telegram', { ...cfg('telegram', 'old'), tabs: updated.tabs })).toEqual({ token: marker, source: 'tokenRef' });
  const backup = text.match(/Backup: ([^\n]+)/)?.[1];
  expect(backup).toBeDefined();
  expect(statSync(backup!).mode & 0o777).toBe(0o600);
  expect(readFileSync(backup!, 'utf8')).toBe(raw);
});

for (const { label, ref, stale } of [
  { label: 'invalid-form', ref: 'secret://discord/bot-token', stale: 'invalid-form' },
  { label: 'missing-secret', ref: 'ref:secret:missing-discord', stale: 'missing-secret' },
] as const) {
  test(`stale ${label} reference is replaced with a fresh secret without exposing the token`, () => {
    const path = join(dir, 'config.json');
    const raw = JSON.stringify({ version: 1, global: {}, tabs: {
      'discord:1': { tokenRef: ref },
    }, discord: { botToken: marker } });
    writeFileSync(path, raw);
    const dry = invoke();
    expect(dry.exitCode).toBe(0);
    expect(dry.stdout.toString()).toContain(`dry-run: discord · action=replace-stale-ref · plaintext=present · stale=${stale}`);
    expect(dry.stdout.toString() + dry.stderr.toString()).not.toContain(marker);
    expect(dry.stdout.toString() + dry.stderr.toString()).not.toContain(ref);
    expect(readFileSync(path, 'utf8')).toBe(raw);
    expect(readdirSync(dir)).toEqual(['config.json']);
    expect(getSecret('discord_1__tokenRef')).toBeUndefined();
    const applied = invoke('--apply');
    expect(applied.exitCode).toBe(0);
    expect(applied.stdout.toString() + applied.stderr.toString()).not.toContain(marker);
    expect(applied.stdout.toString() + applied.stderr.toString()).not.toContain(ref);
    const updated = JSON.parse(readFileSync(path, 'utf8'));
    expect(updated.tabs['discord:1'].tokenRef).toBe('ref:secret:discord_1__tokenRef');
    expect(updated.discord).not.toHaveProperty('botToken');
    expect(getSecret('discord_1__tokenRef')).toBe(marker);
    expect(getSecret('missing-discord')).toBeUndefined();
  });
}

test('stale ref cannot overwrite a conflicting secret at the replacement id', () => {
  const path = join(dir, 'config.json');
  const raw = JSON.stringify({ version: 1, global: {}, tabs: {
    'discord:1': { tokenRef: 'secret://discord/bot-token' },
  }, discord: { botToken: marker } });
  writeFileSync(path, raw);
  setSecret('discord_1__tokenRef', 'different');
  const secretRaw = readFileSync(join(dir, 'secrets.json'), 'utf8');
  const applied = invoke('--apply');
  expect(applied.exitCode).not.toBe(0);
  expect(applied.stderr.toString()).toContain('Channel bot token migration failed: discord: secret conflict');
  expect(applied.stdout.toString() + applied.stderr.toString()).not.toContain(marker);
  expect(applied.stdout.toString() + applied.stderr.toString()).not.toContain('different');
  expect(readFileSync(path, 'utf8')).toBe(raw);
  expect(readFileSync(join(dir, 'secrets.json'), 'utf8')).toBe(secretRaw);
  expect(readdirSync(dir).sort()).toEqual(['config.json', 'secrets.json'].sort());
});

test('a stale discord ref does not prevent a telegram migration', () => {
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({ version: 1, global: {}, tabs: {
    'discord:1': { tokenRef: 'secret://discord/bot-token' },
  }, telegram: { botToken: marker }, discord: { botToken: marker } }));
  const dry = invoke();
  expect(dry.exitCode).toBe(0);
  expect(dry.stdout.toString()).toContain('dry-run: telegram · action=new-ref · plaintext=present');
  expect(dry.stdout.toString()).toContain('dry-run: discord · action=replace-stale-ref · plaintext=present · stale=invalid-form');
  const applied = invoke('--apply');
  expect(applied.exitCode).toBe(0);
  const updated = JSON.parse(readFileSync(path, 'utf8'));
  for (const platform of ['telegram', 'discord'] as const) {
    expect(updated.tabs[`${platform}:1`].tokenRef).toBe(`ref:secret:${platform}_1__tokenRef`);
    expect(updated[platform]).not.toHaveProperty('botToken');
    expect(getSecret(`${platform}_1__tokenRef`)).toBe(marker);
  }
  expect(dry.stdout.toString() + dry.stderr.toString() + applied.stdout.toString() + applied.stderr.toString()).not.toContain(marker);
});

test('apply removes an empty plaintext key without creating an empty secret or tokenRef', () => {
  const path = join(dir, 'config.json');
  const raw = JSON.stringify({ version: 1, global: {}, tabs: {}, telegram: { enabled: true, botToken: '' } });
  writeFileSync(path, raw);
  const dry = invoke();
  expect(dry.exitCode).toBe(0);
  expect(dry.stdout.toString()).toContain('dry-run: telegram · action=remove-empty-plaintext · plaintext=absent · reason=empty-plaintext');
  expect(readFileSync(path, 'utf8')).toBe(raw);
  const applied = invoke('--apply');
  expect(applied.exitCode).toBe(0);
  const updated = JSON.parse(readFileSync(path, 'utf8'));
  expect(updated.telegram).not.toHaveProperty('botToken');
  expect(updated.tabs).toEqual({});
  expect(getSecret('telegram_1__tokenRef')).toBeUndefined();
});

test('a conflict on the second platform prevents migration of the first platform', () => {
  const path = join(dir, 'config.json');
  const raw = JSON.stringify({ version: 1, global: {}, tabs: {
    'discord:1': { tokenRef: 'ref:secret:existing' },
  }, telegram: { botToken: marker }, discord: { botToken: marker } });
  writeFileSync(path, raw);
  setSecret('existing', 'different');
  const applied = invoke('--apply');
  expect(applied.exitCode).not.toBe(0);
  expect(readFileSync(path, 'utf8')).toBe(raw);
  expect(getSecret('telegram_1__tokenRef')).toBeUndefined();
  expect(getSecret('existing')).toBe('different');
  expect(applied.stderr.toString()).toContain('Channel bot token migration failed: discord: secret conflict');
  expect(applied.stdout.toString() + applied.stderr.toString()).not.toContain(marker);
});

test('getUserConfig preserves tabs and the resolver uses the passed config, not a second disk read', () => {
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ version: 1, global: {}, tabs: {
    'telegram:1': { tokenRef: 'ref:secret:canonical' },
  }, telegram: { enabled: true, allowedUsers: [19], botToken: 'old' } }));
  setSecret('canonical', marker);
  const loaded = getUserConfig();
  expect(resolveChannelBotToken('telegram', loaded)).toEqual({ token: marker, source: 'tokenRef' });
  saveUserConfig(loaded, join(dir, 'config.json'));
  const saved = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
  expect(saved.tabs['telegram:1'].tokenRef).toBe('ref:secret:canonical');
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ version: 1, global: {}, tabs: {} }));
  expect(resolveChannelBotToken('telegram', loaded)).toEqual({ token: marker, source: 'tokenRef' });
});

test('tokenRef resolution takes precedence over an env-derived plaintext config value', () => {
  const config = cfg('telegram', 'env-bridge-value');
  config.tabs = { 'telegram:1': { tokenRef: 'ref:secret:canonical' } };
  setSecret('canonical', marker);
  expect(resolveChannelBotToken('telegram', config)).toEqual({ token: marker, source: 'tokenRef' });
});

test('telegram botFromConfig consumes the resolved token and preserves the allowlist', async () => {
  const { botFromConfig } = await import('./telegram.js');
  const config = cfg('telegram', 'legacy');
  config.telegram.allowedUsers = [19];
  config.tabs = { 'telegram:1': { tokenRef: 'ref:secret:canonical' } };
  setSecret('canonical', marker);
  const bot = botFromConfig({ userConfig: config });
  expect((bot as unknown as { token: string }).token).toBe(marker);
  expect((bot as unknown as { allowedUsers: Set<number> }).allowedUsers).toEqual(new Set([19]));
});

test('telegram botFromConfig retains the missing-token exception with no credential source', async () => {
  const { botFromConfig } = await import('./telegram.js');
  expect(() => botFromConfig({ userConfig: cfg('telegram', '') })).toThrow(/botToken/);
});

test('mission origin and report fallback use tokenRef rather than stale plaintext', () => {
  const config = cfg('telegram', 'stale:token');
  config.telegram.homeChannel = 42;
  config.telegram.reportChannel = { chatId: 42 };
  config.tabs = { 'telegram:1': { tokenRef: 'ref:secret:canonical' } };
  setSecret('canonical', marker);
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ version: 1, global: {}, ...config }));
  resetUserConfig();
  expect(defaultTelegramOrigin()).toEqual({ channel: 'telegram', chatId: 42, botId: marker.split(':')[0] });
  expect(resolveReportTarget(config)).toEqual({ chatId: 42, botToken: marker });
  config.tabs = {};
  expect(resolveReportTarget(config)).toEqual({ chatId: 42, botToken: 'stale:token' });
});

test('trigger bot uses caller-resolved token and preserves missing-token no-op', async () => {
  const config = cfg('telegram', 'stale');
  config.telegram.allowedUsers = [19];
  config.tabs = { 'telegram:1': { tokenRef: 'ref:secret:canonical' } };
  setSecret('canonical', marker);
  const token = resolveChannelBotToken('telegram', config)?.token;
  expect(createNexusTelegramTriggerBot({ token: '', allowedUsers: [19], dispatch: async () => undefined })).toBeNull();
  const handle = createNexusTelegramTriggerBot({
    token: token!, allowedUsers: [19], dispatch: async () => undefined,
    userConfig: config, poll: false, log: () => {},
  });
  expect(handle).not.toBeNull();
  expect((handle!.bot as unknown as { token: string }).token).toBe(marker);
  expect((handle!.bot as unknown as { allowedUsers: Set<number> }).allowedUsers).toEqual(new Set([19]));
  await handle!.stop();
});

test('nexus poller wiring passes the resolved token to the trigger bot, preserving the allowlist', () => {
  const config = cfg('telegram', 'stale:token');
  config.telegram.allowedUsers = [19];
  config.tabs = { 'telegram:1': { tokenRef: 'ref:secret:canonical' } };
  setSecret('canonical', marker);
  const received: Array<{ token: string; allowedUsers: number[] }> = [];
  const { resolveTelegramChannels, interactivePollerTokens } = require('./domains/telegram-channels.js');
  const wired = wireNexusTelegramQaPollers(config, { dispatchTelegram: async () => undefined } as never, {
    resolveTelegramChannels, interactivePollerTokens,
    makeTelegramAgentRunTurn: () => (async () => ({ text: '' })) as never,
    createTriggerBot: (opts) => {
      received.push({ token: opts.token, allowedUsers: opts.allowedUsers });
      return { bot: {} as never, stop: async () => undefined };
    },
  });
  expect(wired.map(({ channel }) => channel.botToken)).toEqual([marker]);
  expect(received).toEqual([{ token: marker, allowedUsers: [19] }]);
});

test('standalone telegram run rejects missing resolved token before polling', async () => {
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ version: 1, global: {}, telegram: { enabled: true, allowedUsers: [] } }));
  resetUserConfig();
  await expect(startTelegramPollers()).rejects.toThrow(/bot token 못 풂 — no-source/);
});

test('standalone telegram run acquires the main channel token without top-level botToken or secret', async () => {
  const config = cfg('telegram', '');
  config.telegram.poller = 'standalone';
  config.telegram.channels = [{ name: 'main', botToken: marker, chatId: 19, interactive: true, roles: ['qa'] }];
  config.tabs = { 'telegram:1': { tokenRef: 'ref:secret:missing' } };
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ version: 1, global: {}, ...config }));
  resetUserConfig();
  const seen: string[] = [];
  const restore = setTelegramPollLockForTesting({
    acquire: async token => {
      seen.push(token);
      return { ok: false, holder: null, path: join(dir, 'not-acquired'), waitedMs: 0 };
    },
    retry: async () => ({ ok: false }),
  });
  try {
    const result = await startTelegramPollers();
    expect(seen).toEqual([marker]);
    expect(result.started).toHaveLength(0);
  } finally { restore(); }
});

test('standalone telegram run selects the secret before trying to acquire its poll lock', async () => {
  const config = cfg('telegram', 'stale:token');
  config.telegram.poller = 'standalone';
  config.tabs = { 'telegram:1': { tokenRef: 'ref:secret:canonical' } };
  setSecret('canonical', marker);
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ version: 1, global: {}, ...config }));
  resetUserConfig();
  const seen: string[] = [];
  const restore = setTelegramPollLockForTesting({
    acquire: async (token) => {
      seen.push(token);
      return { ok: false, holder: null, path: join(dir, 'not-acquired'), waitedMs: 0 };
    },
    retry: async () => ({ ok: false }),
  });
  try {
    const result = await startTelegramPollers();
    expect(seen).toEqual([marker]);
    expect(result.refusedBotIds).toEqual([marker.split(':')[0]]);
    expect(result.started).toHaveLength(0);
    expect(result.late).toHaveLength(0);
  } finally { restore(); }
});

test('conflicting secret stops apply without changing config', () => {
  const path = join(dir, 'config.json');
  const raw = JSON.stringify({ version: 1, global: {}, tabs: { 'telegram:1': { tokenRef: 'ref:secret:existing' } }, telegram: { botToken: marker } });
  writeFileSync(path, raw);
  setSecret('existing', 'different');
  const secretRaw = readFileSync(join(dir, 'secrets.json'), 'utf8');
  const dry = invoke();
  expect(dry.exitCode).toBe(0);
  expect(dry.stdout.toString()).toContain('dry-run: telegram · action=reuse-ref · plaintext=present');
  expect(readFileSync(path, 'utf8')).toBe(raw);
  expect(readFileSync(join(dir, 'secrets.json'), 'utf8')).toBe(secretRaw);
  const result = invoke('--apply');
  expect(result.exitCode).not.toBe(0);
  expect(readFileSync(path, 'utf8')).toBe(raw);
  expect(getSecret('existing')).toBe('different');
  expect(readFileSync(join(dir, 'secrets.json'), 'utf8')).toBe(secretRaw);
  expect(getSecret('telegram_1__tokenRef')).toBeUndefined();
  expect(getSecret('discord_1__tokenRef')).toBeUndefined();
  expect(readdirSync(dir).sort()).toEqual(['config.json', 'secrets.json'].sort());
  expect(result.stderr.toString()).toContain('Channel bot token migration failed: telegram: secret conflict');
  expect(result.stdout.toString() + result.stderr.toString()).not.toContain(marker);
  expect(result.stdout.toString() + result.stderr.toString()).not.toContain('different');
});

test('rerunning apply when tokenRef already matches cleans only the legacy key', () => {
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({ version: 1, global: {}, tabs: {
    'discord:1': { tokenRef: 'ref:secret:preexisting' },
  }, discord: { enabled: true, botToken: marker } }));
  setSecret('preexisting', marker);
  const dry = invoke();
  expect(dry.exitCode).toBe(0);
  expect(dry.stdout.toString()).toContain('dry-run: discord · action=reuse-ref · plaintext=present');
  expect(dry.stdout.toString() + dry.stderr.toString()).not.toContain(marker);
  const result = invoke('--apply');
  expect(result.exitCode).toBe(0);
  const updated = JSON.parse(readFileSync(path, 'utf8'));
  expect(updated.discord).not.toHaveProperty('botToken');
  expect(updated.tabs['discord:1'].tokenRef).toBe('ref:secret:preexisting');
  expect(getSecret('discord_1__tokenRef')).toBeUndefined();
  expect(getSecret('preexisting')).toBe(marker);
  expect(result.stdout.toString() + result.stderr.toString()).not.toContain(marker);
});

test('--help and -h print usage successfully without touching config or secrets', () => {
  for (const flag of ['--help', '-h']) {
    const result = invoke(flag);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain('usage: channel-bot-token-migrate.ts');
    expect(result.stderr.toString()).toBe('');
    expect(result.stdout.toString() + result.stderr.toString()).not.toContain(marker);
  }
  expect(readdirSync(dir)).toEqual([]);
});

test('invalid botToken and usage failures name their reason but never print values', () => {
  const path = join(dir, 'config.json');
  const raw = JSON.stringify({ version: 1, global: {}, discord: { botToken: { value: marker } } });
  writeFileSync(path, raw);
  const invalid = invoke();
  expect(invalid.exitCode).not.toBe(0);
  expect(invalid.stderr.toString()).toContain('Channel bot token migration failed: discord: invalid botToken');
  expect(invalid.stdout.toString() + invalid.stderr.toString()).not.toContain(marker);
  const usage = invoke('--unknown');
  expect(usage.exitCode).not.toBe(0);
  expect(usage.stderr.toString()).toContain('Channel bot token migration failed: migration: usage');
  expect(usage.stdout.toString() + usage.stderr.toString()).not.toContain(marker);
  expect(readFileSync(path, 'utf8')).toBe(raw);
  expect(readdirSync(dir)).toEqual(['config.json']);
});

test('dry-run marks a platform without plaintext as skipped and apply leaves its stale ref untouched', () => {
  const path = join(dir, 'config.json');
  const raw = JSON.stringify({ version: 1, global: {}, tabs: {
    'discord:1': { tokenRef: 'secret://discord/bot-token' },
  }, telegram: { botToken: marker }, discord: { enabled: true } });
  writeFileSync(path, raw);
  const dry = invoke();
  expect(dry.exitCode).toBe(0);
  expect(dry.stdout.toString().trim().split('\n')).toEqual([
    'dry-run: telegram · action=new-ref · plaintext=present',
    'dry-run: discord · action=skipped · plaintext=absent · stale=invalid-form · reason=no-plaintext',
  ]);
  expect(dry.stdout.toString() + dry.stderr.toString()).not.toContain(marker);
  expect(readFileSync(path, 'utf8')).toBe(raw);
  expect(readdirSync(dir)).toEqual(['config.json']);
  const applied = invoke('--apply');
  expect(applied.exitCode).toBe(0);
  const updated = JSON.parse(readFileSync(path, 'utf8'));
  expect(updated.tabs['telegram:1'].tokenRef).toBe('ref:secret:telegram_1__tokenRef');
  expect(updated.telegram).not.toHaveProperty('botToken');
  expect(updated.tabs['discord:1'].tokenRef).toBe('secret://discord/bot-token');
  expect(updated.discord).toEqual({ enabled: true });
  expect(getSecret('discord_1__tokenRef')).toBeUndefined();
  expect(applied.stdout.toString()).not.toContain('migrated: discord');
  expect(applied.stdout.toString() + applied.stderr.toString()).not.toContain(marker);
});

test('dry-run skips absent plaintext with either stale or missing ref; apply changes nothing', () => {
  const path = join(dir, 'config.json');
  const raw = JSON.stringify({ version: 1, global: {}, tabs: {
    'discord:1': { tokenRef: 'ref:secret:missing-discord' },
  }, telegram: { enabled: true }, discord: { enabled: true } });
  writeFileSync(path, raw);
  const dry = invoke();
  expect(dry.exitCode).toBe(0);
  expect(dry.stdout.toString().trim().split('\n')).toEqual([
    'dry-run: telegram · action=skipped · plaintext=absent · reason=no-plaintext',
    'dry-run: discord · action=skipped · plaintext=absent · stale=missing-secret · reason=no-plaintext',
  ]);
  expect(readFileSync(path, 'utf8')).toBe(raw);
  expect(readdirSync(dir)).toEqual(['config.json']);
  const applied = invoke('--apply');
  expect(applied.exitCode).toBe(0);
  expect(applied.stdout.toString()).toContain('Nothing to migrate');
  expect(readFileSync(path, 'utf8')).toBe(raw);
  expect(readdirSync(dir)).toEqual(['config.json']);
  expect(dry.stdout.toString() + dry.stderr.toString() + applied.stdout.toString() + applied.stderr.toString()).not.toContain(marker);
});

test('verify fails closed when a configured tokenRef has no secret, even with env fallback', () => {
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({ version: 1, global: {}, tabs: {
    'telegram:1': { tokenRef: 'ref:secret:missing' },
  }, telegram: { botToken: marker } }));
  const raw = readFileSync(path, 'utf8');
  const result = invokeWithEnv({ ELANOUS_TELEGRAM_BOT_TOKEN: marker }, '--verify');
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain('telegram: verification failed (tokenRef secret unavailable)');
  expect(result.stdout.toString() + result.stderr.toString()).not.toContain(marker);
  expect(readFileSync(path, 'utf8')).toBe(raw);
});

test('verify fails when a configured tokenRef is missing and no fallback exists', () => {
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({ version: 1, global: {}, tabs: {
    'discord:1': { tokenRef: 'ref:secret:missing' },
  } }));
  const result = invoke('--verify');
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain('discord: verification failed (tokenRef secret unavailable)');
  expect(result.stdout.toString()).toBe('');
});

test('apply rejects a differing env token before backing up or writing secrets', () => {
  const path = join(dir, 'config.json');
  const raw = JSON.stringify({ version: 1, global: {}, tabs: {}, telegram: { botToken: marker } });
  writeFileSync(path, raw);
  const result = invokeWithEnv({ ELANOUS_TELEGRAM_BOT_TOKEN: 'different-env-token' }, '--apply');
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain('Channel bot token migration failed: telegram: environment token conflict');
  expect(result.stdout.toString() + result.stderr.toString()).not.toContain(marker);
  expect(result.stdout.toString() + result.stderr.toString()).not.toContain('different-env-token');
  expect(readFileSync(path, 'utf8')).toBe(raw);
  expect(readdirSync(dir)).toEqual(['config.json']);
  expect(getSecret('telegram_1__tokenRef')).toBeUndefined();
});

test('verify reports failure without exposing the token or fetch error', async () => {
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({ version: 1, global: {}, tabs: {
    'telegram:1': { tokenRef: 'ref:secret:tg' },
  } }));
  setSecret('tg', marker);
  const previousFetch = globalThis.fetch;
  const originalError = console.error;
  const lines: string[] = [];
  globalThis.fetch = (async () => { throw new Error(marker); }) as unknown as typeof fetch;
  console.error = (...args) => { lines.push(args.join(' ')); };
  try {
    const { verifyChannelBotTokens } = await import('../scripts/ops/channel-bot-token-migrate.js');
    expect(await verifyChannelBotTokens()).toBe(false);
    expect(lines).toEqual(['telegram: verification failed']);
    expect(lines.join(' ')).not.toContain(marker);
  } finally {
    console.error = originalError;
    globalThis.fetch = previousFetch;
  }
});

test('verify calls platform APIs with resolved tokens and prints only bot names', async () => {
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({ version: 1, global: {}, tabs: {
    'telegram:1': { tokenRef: 'ref:secret:tg' }, 'discord:1': { tokenRef: 'ref:secret:dc' },
  }, telegram: { botToken: 'stale' }, discord: { botToken: 'stale' } }));
  setSecret('tg', marker);
  setSecret('dc', marker);
  const previousFetch = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(String(input).includes('/getMe') ? 'telegram' : 'discord');
    if (seen.at(-1) === 'telegram') expect(String(input)).toContain(`/bot${marker}/getMe`);
    expect(init?.headers).toEqual(seen.at(-1) === 'discord' ? { Authorization: `Bot ${marker}` } : undefined);
    return new Response(JSON.stringify(seen.at(-1) === 'telegram'
      ? { ok: true, result: { username: 'tg_bot' } }
      : { username: 'dc_bot' }), { status: 200 });
  }) as typeof fetch;
  try {
    const { verifyChannelBotTokens } = await import('../scripts/ops/channel-bot-token-migrate.js');
    const originalLog = console.log;
    const lines: string[] = [];
    console.log = (...args) => { lines.push(args.join(' ')); };
    try { await verifyChannelBotTokens(); } finally { console.log = originalLog; }
    expect(seen).toEqual(['telegram', 'discord']);
    expect(lines).toEqual(['telegram: tg_bot', 'discord: dc_bot']);
    expect(lines.join(' ')).not.toContain(marker);
  } finally { globalThis.fetch = previousFetch; }
});
