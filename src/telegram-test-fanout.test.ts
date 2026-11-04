import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTelegramTestConfig } from './telegram-test-runner.js';
import { setElanousConfigDir, resetElanousConfigDir } from './elanous-config-dir.js';
import { buildUserConfig, reloadUserConfig, saveUserConfig } from './user-config.js';
import { createNexusTelegramTriggerBot } from './nexus/api/telegram-trigger-bot.js';
import { _clearSurfaceSinksForTest, fanOutSessionOutput } from './session/session-fanout.js';
import { createSession, subscribeSession } from './session/index.js';
import { telegramEndpointKey } from './session/session-endpoint-key.js';
import { parsePersonaYaml } from './persona/loader.js';
import type { TelegramBot } from './telegram.js';

const testRoots: string[] = [];
const envBefore = {
  stateDir: process.env.ELANOUS_STATE_DIR,
  sessionRoot: process.env.ELANOUS_SESSION_ROOT,
};

afterEach(() => {
  _clearSurfaceSinksForTest();
  resetElanousConfigDir();
  if (envBefore.stateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
  else process.env.ELANOUS_STATE_DIR = envBefore.stateDir;
  if (envBefore.sessionRoot === undefined) delete process.env.ELANOUS_SESSION_ROOT;
  else process.env.ELANOUS_SESSION_ROOT = envBefore.sessionRoot;
  for (const root of testRoots.splice(0)) {
    reloadUserConfig(join(root, 'absent-config-after-test.json'));
    rmSync(root, { recursive: true, force: true });
  }
});

describe('Telegram test persona and primary session fan-out', () => {
  test('loads botlab-4 without credentials', () => {
    const path = join(import.meta.dir, '../personas/botlab-4.yaml');
    const loaded = parsePersonaYaml(readFileSync(path, 'utf8'), path);
    expect(loaded).toMatchObject({
      ok: true,
      profile: { personaId: 'botlab-4', displayName: 'Botlab 4' },
    });
    expect(readFileSync(path, 'utf8')).not.toMatch(/\b(botToken|apiKey|secret|password)\s*:/i);
  });

  test('test config primary.telegram sends a TUI session reply to its Telegram subscriber', async () => {
    const root = mkdtempSync(join(tmpdir(), 'telegram-test-primary-fanout-'));
    testRoots.push(root);
    const sessionsRoot = join(root, 'sessions');
    const configPath = join(root, 'config.json');
    mkdirSync(sessionsRoot, { recursive: true });
    process.env.ELANOUS_STATE_DIR = root;
    process.env.ELANOUS_SESSION_ROOT = sessionsRoot;
    setElanousConfigDir(root);

    const productionShape = buildUserConfig(join(root, 'absent-production-config.json'));
    productionShape.sessionFabric = { primary: { telegram: true } };
    const testConfig = buildTelegramTestConfig(productionShape, '123456:synthetic-test-only', [42]);
    saveUserConfig(testConfig, configPath);
    reloadUserConfig(configPath);

    const session = createSession({ source: 'tui', title: 'isolated TUI session' }, sessionsRoot);
    subscribeSession(session.id, {
      surface: 'telegram',
      endpoint: telegramEndpointKey({ chatId: 42, botId: '123456' }),
    }, {}, sessionsRoot);

    const sent: Array<{ chatId: number; text: string }> = [];
    const bot = {
      sendMessage: async (chatId: number, text: string) => {
        sent.push({ chatId, text });
        return { messageId: 7 };
      },
      onCallbackQuery: () => () => {},
      stop: () => {},
    } as unknown as TelegramBot;
    const handle = createNexusTelegramTriggerBot({
      token: '123456:synthetic-test-only',
      allowedUsers: [42],
      dispatch: async () => undefined,
      bot,
      userConfig: testConfig,
    });
    if (!handle) throw new Error('test Telegram bot was not constructed');

    try {
      const result = await fanOutSessionOutput(session.id, {
        kind: 'message', role: 'assistant', text: 'TUI reply in isolated Telegram test universe',
      });
      expect(result).toMatchObject({ targeted: 1, delivered: 1, failed: 0, skipped: 0 });
      expect(sent).toEqual([{ chatId: 42, text: 'TUI reply in isolated Telegram test universe' }]);
      expect(buildUserConfig(configPath).sessionFabric?.primary?.telegram).toBe(true);
    } finally {
      await handle.stop();
    }
  });
});
