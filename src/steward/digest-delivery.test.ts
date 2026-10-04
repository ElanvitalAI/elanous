import { expect, test } from 'bun:test';
import type { UserConfig } from '../user-config.js';
import { sendTelegramDirect } from '../domains/outbound-alert.js';
import { DEFAULT_KIND_ROLES, isTradingKind } from '../domains/telegram-kind-route.js';

test('steward operations report direct fallback stays on the operations bot, not the trading bot', () => {
  const cfg = { telegram: {
    enabled: true, botToken: 'OPS:fake', homeChannel: 101, allowedUsers: [101],
    reportChannel: { botToken: 'TRADING:fake', chatId: 202 },
    channels: [
      { name: 'ops', botToken: 'OPS:fake', chatId: 101, interactive: true, roles: ['system'] },
      { name: 'trading', botToken: 'TRADING:fake', chatId: 202, interactive: false, roles: ['report'] },
    ],
  } } as UserConfig;
  const calls: Array<[string, string]> = [];
  expect(sendTelegramDirect('스튜어드 2026-10-04', 'ops-report', {
    config: cfg,
    sendRaw: (token, chatId) => { calls.push([token, String(chatId)]); return true; },
    legacyEnv: () => { throw new Error('trading env must not be read'); },
  })).toBe(true);
  expect(calls).toEqual([['OPS:fake', '101']]);
  expect(DEFAULT_KIND_ROLES['ops-report']).toBe('system');
  expect(isTradingKind('ops-report')).toBe(false);
  expect(isTradingKind('digest')).toBe(true);
});
