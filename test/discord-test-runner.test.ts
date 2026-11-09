// `elanous discord-test` — config builder + discord.testChannel schema.
//
// PLAN-multi-surface-pty-shell M4a-0: unlike telegram (409-forced token
// split), the discord test session reuses the PRODUCTION token and
// isolates by channel. The builder drops outbound-to-production routes
// (homeChannel) and the prod-app slash wiring (sprint21).

import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDiscordTestConfig } from '../src/discord-test-runner.js';
import { buildUserConfig } from '../src/user-config.js';
import type { UserConfig } from '../src/user-config/types.js';

function prodCfg(): UserConfig {
  return {
    llm: { provider: 'grok', model: 'grok-4.6' },
    discord: {
      enabled: true,
      botToken: 'PROD-TOKEN',
      allowedUsers: ['514820469845655553'],
      homeChannel: '1500104676551430155',
      testChannel: { channelId: '1525654199935963227' },
    },
    raw: {},
  } as unknown as UserConfig;
}

describe('buildDiscordTestConfig', () => {
  test('keeps the (same-app) token + allowlist, drops outbound-to-prod routes', () => {
    const t = buildDiscordTestConfig(prodCfg(), 'PROD-TOKEN', ['42']);
    expect(t.discord.botToken).toBe('PROD-TOKEN');
    expect(t.discord.allowedUsers).toEqual(['42']);
    expect(t.discord.enabled).toBe(true);
    // Outbound-to-prod route removed so the test bot stays contained.
    expect(t.discord.homeChannel).toBeUndefined();
  });

  test('preserves the rest of the production config (LLM keys etc.)', () => {
    const prod = prodCfg();
    const t = buildDiscordTestConfig(prod, 'PROD-TOKEN', ['42']);
    expect(t.llm).toEqual(prod.llm);
    expect(t.raw).toBe(prod.raw);
  });

  test('does not mutate the input production config', () => {
    const prod = prodCfg();
    buildDiscordTestConfig(prod, 'PROD-TOKEN', ['42']);
    expect(prod.discord.homeChannel).toBe('1500104676551430155');
  });
});

describe('discord.testChannel schema', () => {
  test('normalizes channelId (snowflake string) + optional fields', () => {
    const dir = mkdtempSync(join(tmpdir(), 'discord-test-cfg-'));
    try {
      const p = join(dir, 'config.json');
      // NOTE: snowflakes MUST be stored as strings — a bare JSON number
      // above 2^53 loses precision at parse time. The normalizer's
      // number branch exists only for small legacy values.
      writeFileSync(p, JSON.stringify({
        discord: {
          enabled: true,
          botToken: 'T',
          allowedUsers: [],
          testChannel: { channelId: '1525654199935963227', allowedUsers: ['514820469845655553'] },
        },
      }));
      const cfg = buildUserConfig(p);
      expect(cfg.discord.testChannel?.channelId).toBe('1525654199935963227');
      expect(cfg.discord.testChannel?.allowedUsers).toEqual(['514820469845655553']);
      expect(cfg.discord.testChannel?.botToken).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('missing channelId ⇒ testChannel off (fail-soft)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'discord-test-cfg-'));
    try {
      const p = join(dir, 'config.json');
      writeFileSync(p, JSON.stringify({
        discord: { enabled: true, allowedUsers: [], testChannel: { allowedUsers: ['1'] } },
      }));
      expect(buildUserConfig(p).discord.testChannel).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
