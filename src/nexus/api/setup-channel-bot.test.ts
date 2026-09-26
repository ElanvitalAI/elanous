import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { debug } from '../../debug/log.js';
import { storeChannelBotToken } from '../../channel-bot-token.js';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetElanousConfigDir, setElanousConfigDir } from '../../elanous-config-dir.js';
import { getSecret, useBackend } from '../config/secrets/index.js';
import { resetUserConfig } from '../../user-config.js';
import { handleChannelBotsGet, handleChannelBotSet } from './setup-channel-bot.js';

const token = 'secret-token-do-not-echo';
let dir: string;
let originalEnv: string | undefined;
const request = (body: unknown) => new Request('http://localhost/v1/setup/channel-bot', { method: 'POST', body: JSON.stringify(body) });
const fakeFetch = (async (url: RequestInfo | URL) => {
  expect(String(url)).toContain(`/bot${token}/getMe`);
  return Response.json({ ok: true, result: { username: 'test_bot' } });
}) as typeof fetch;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'setup-channel-bot-'));
  setElanousConfigDir(dir);
  useBackend('file');
  resetUserConfig();
  originalEnv = process.env.ELANOUS_TELEGRAM_BOT_TOKEN;
  delete process.env.ELANOUS_TELEGRAM_BOT_TOKEN;
});
afterEach(() => {
  if (originalEnv === undefined) delete process.env.ELANOUS_TELEGRAM_BOT_TOKEN;
  else process.env.ELANOUS_TELEGRAM_BOT_TOKEN = originalEnv;
  resetUserConfig();
  resetElanousConfigDir();
  rmSync(dir, { recursive: true, force: true });
});

test('a successful fake getMe POST persists the secret and excludes credentials from responses', async () => {
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({ telegram: { botToken: 'old', enabled: true } }));
  const logs = spyOn(debug, 'log');
  const response = await handleChannelBotSet(request({ platform: 'telegram', token, allowedUsers: ['19'] }), fakeFetch);
  expect(logs).toHaveBeenCalledWith('pwa.settings', 'channel-bot-set', { platform: 'telegram', probed: true, allowedUsersCount: 1 });
  expect(JSON.stringify(logs.mock.calls)).not.toContain(token);
  logs.mockRestore();
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(text).toBe(JSON.stringify({ ok: true, botName: 'test_bot', restartNeeded: true }));
  expect(text).not.toContain(token);
  const disk = JSON.parse(readFileSync(path, 'utf8'));
  expect(disk.tabs['telegram:1'].tokenRef).toBe('ref:secret:telegram_1__tokenRef');
  expect(disk.telegram).toEqual({ enabled: true, allowedUsers: [19] });
  expect(getSecret('telegram_1__tokenRef')).toBe(token);
  const status = await handleChannelBotsGet().text();
  expect(status).not.toContain(token);
  expect(status).not.toContain('old');
  expect(status).not.toContain(String(token.length));
  expect(JSON.parse(status).platforms[0]).toEqual({ platform: 'telegram', configured: true, source: 'tokenRef', allowedUsers: ['19'] });
});

test('untrusted bot name cannot echo the submitted token', async () => {
  const response = await handleChannelBotSet(request({ platform: 'telegram', token }),
    (async () => Response.json({ ok: true, result: { username: token } })) as unknown as typeof fetch);
  expect(response.status).toBe(200);
  expect(await response.text()).toBe('{"ok":true,"restartNeeded":true}');
});

test('failed probe leaves config and secrets unchanged', async () => {
  const path = join(dir, 'config.json');
  const before = JSON.stringify({ telegram: { botToken: 'old', allowedUsers: [19] } });
  writeFileSync(path, before);
  const fetchFailure = (async () => { throw new Error(`https://api.telegram.org/bot${token}/getMe`); }) as unknown as typeof fetch;
  const response = await handleChannelBotSet(request({ platform: 'telegram', token, allowedUsers: ['21'] }), fetchFailure);
  expect(response.status).toBe(400);
  expect(await response.text()).toBe('{"error":"bot-token-rejected"}');
  expect(readFileSync(path, 'utf8')).toBe(before);
  expect(getSecret('telegram_1__tokenRef')).toBeUndefined();
});

test('invalid allowlist does not probe or write; tokenless allowlist update preserves the existing secret', async () => {
  const path = join(dir, 'config.json');
  const before = JSON.stringify({ discord: { allowedUsers: ['123'] } });
  writeFileSync(path, before);
  await storeChannelBotToken('discord', token);
  const existingSecret = getSecret('discord_1__tokenRef');
  expect(existingSecret).toBe(token);
  const storedConfig = readFileSync(path, 'utf8');
  const invalid = await handleChannelBotSet(request({ platform: 'discord', token, allowedUsers: [123] }),
    (async () => { throw new Error('probe should not run'); }) as unknown as typeof fetch);
  expect(invalid.status).toBe(400);
  expect(readFileSync(path, 'utf8')).toBe(storedConfig);
  expect(getSecret('discord_1__tokenRef')).toBe(existingSecret);
  const telegramBefore = JSON.stringify({ telegram: { allowedUsers: [19] } });
  writeFileSync(path, telegramBefore);
  for (const id of ['abc', '9007199254740992']) {
    const rejected = await handleChannelBotSet(request({ platform: 'telegram', token, allowedUsers: [id] }),
      (async () => { throw new Error('probe should not run'); }) as unknown as typeof fetch);
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({ error: 'invalid-allowed-users' });
    expect(readFileSync(path, 'utf8')).toBe(telegramBefore);
    expect(getSecret('telegram_1__tokenRef')).toBeUndefined();
  }
  writeFileSync(path, storedConfig);
  const updated = await handleChannelBotSet(request({ platform: 'discord', allowedUsers: ['456'] }));
  expect(updated.status).toBe(200);
  expect(JSON.parse(readFileSync(path, 'utf8')).discord.allowedUsers).toEqual(['456']);
  expect(getSecret('discord_1__tokenRef')).toBe(existingSecret);
});

test('허용 사용자만 고치는 저장(토큰 없음)은 아직 옮기지 않은 평문 토큰을 지우지 않는다', async () => {
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({ telegram: { botToken: 'still-plaintext', enabled: true } }));
  const response = await handleChannelBotSet(request({ platform: 'telegram', allowedUsers: ['42'] }), fakeFetch);
  expect(response.status).toBe(200);
  const saved = JSON.parse(readFileSync(path, 'utf8')) as { telegram?: { botToken?: string; allowedUsers?: unknown[] } };
  expect(saved.telegram?.botToken).toBe('still-plaintext');
  expect(saved.telegram?.allowedUsers).toEqual([42]);
});
