// `elanous telegram-test` config builder — clones the production config with
// a TEST token + allowlist and drops outbound-to-production routes so the
// standalone test bot can't post into live report/home chats.

import { describe, test, expect } from 'bun:test';
import { buildTelegramTestConfig } from '../src/telegram-test-runner.js';
import type { UserConfig } from '../src/user-config/types.js';

function prodCfg(): UserConfig {
  return {
    llm: { provider: 'grok', model: 'grok-4.6' },
    telegram: {
      enabled: true,
      botToken: '8799226199:PROD',
      allowedUsers: [1301607555],
      homeChannel: 1301607555,
      reportChannel: { chatId: 1301607555, botToken: '8755824181:REPORT' },
      channels: [{ name: 'trading', botToken: '8755824181:REPORT', chatId: 1301607555, interactive: true, roles: [] }],
    },
    raw: {},
  } as unknown as UserConfig;
}

describe('buildTelegramTestConfig', () => {
  test('swaps the token + allowlist, drops outbound-to-prod routes', () => {
    const t = buildTelegramTestConfig(prodCfg(), '8724930076:TEST', [42]);
    expect(t.telegram.botToken).toBe('8724930076:TEST');
    expect(t.telegram.allowedUsers).toEqual([42]);
    expect(t.telegram.enabled).toBe(true);
    // Outbound-to-production routes removed so the test bot stays contained.
    expect(t.telegram.reportChannel).toBeUndefined();
    expect(t.telegram.channels).toBeUndefined();
    expect(t.telegram.homeChannel).toBeUndefined();
  });

  test('preserves the rest of the production config (LLM keys etc.)', () => {
    const prod = prodCfg();
    const t = buildTelegramTestConfig(prod, '8724930076:TEST', [42]);
    expect(t.llm).toEqual(prod.llm); // untouched — test bot reuses prod LLM config
    expect(t.raw).toBe(prod.raw);
  });

  test('does not mutate the input production config', () => {
    const prod = prodCfg();
    buildTelegramTestConfig(prod, '8724930076:TEST', [42]);
    expect(prod.telegram.botToken).toBe('8799226199:PROD'); // original intact
    expect(prod.telegram.reportChannel).toBeDefined();
  });
});
