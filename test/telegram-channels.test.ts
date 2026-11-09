import { describe, expect, test } from 'bun:test';

import {
  resolveTelegramChannels,
  interactivePollerTokens,
  channelForRole,
} from '../src/domains/telegram-channels.js';
import type { TelegramConfig } from '../src/user-config/types.js';

function tg(over: Partial<TelegramConfig> = {}): TelegramConfig {
  return { enabled: true, allowedUsers: [111], ...over };
}

describe('resolveTelegramChannels — legacy 파생(하위호환)', () => {
  test('botToken 만 → main 채널(qa+alert+report·report채널 없음)', () => {
    const ch = resolveTelegramChannels(tg({ botToken: 'MAIN', homeChannel: 555 }));
    expect(ch).toHaveLength(1);
    expect(ch[0]!.name).toBe('main');
    expect(ch[0]!.botToken).toBe('MAIN');
    expect(ch[0]!.chatId).toBe(555);
    expect(ch[0]!.interactive).toBe(true);
    expect(ch[0]!.roles).toContain('qa');
    expect(ch[0]!.roles).toContain('alert'); // report 채널 없으면 메인이 흡수
  });

  test('reportChannel 별도 토큰 → main + alert(둘 다 interactive·다른 토큰)', () => {
    const ch = resolveTelegramChannels(tg({ botToken: 'MAIN', homeChannel: 555, reportChannel: { chatId: 555, botToken: 'ALERT' } }));
    expect(ch).toHaveLength(2);
    const alert = ch.find(c => c.name === 'alert')!;
    expect(alert.botToken).toBe('ALERT');
    expect(alert.interactive).toBe(true);
    expect(alert.roles).toContain('alert');
    // 메인은 alert 역할 안 가짐(별도 alert 채널 존재).
    expect(ch.find(c => c.name === 'main')!.roles).not.toContain('alert');
  });

  test('reportChannel 토큰 없음(메인 봇 공유) → alert 는 noti-only(interactive:false·같은 토큰)', () => {
    const ch = resolveTelegramChannels(tg({ botToken: 'MAIN', reportChannel: { chatId: 999 } }));
    const alert = ch.find(c => c.name === 'alert')!;
    expect(alert.botToken).toBe('MAIN');
    expect(alert.interactive).toBe(false);
    expect(alert.chatId).toBe(999);
  });

  test('homeChannel 없으면 allowedUsers[0] 로 chatId 대체', () => {
    const ch = resolveTelegramChannels(tg({ botToken: 'MAIN', allowedUsers: [777] }));
    expect(ch[0]!.chatId).toBe(777);
  });
});

describe('resolveTelegramChannels — 명시 channels 우선', () => {
  test('channels 지정 시 legacy 무시하고 그대로', () => {
    const ch = resolveTelegramChannels(tg({
      botToken: 'MAIN',
      channels: [
        { name: 'a', botToken: 'TA', chatId: 1, interactive: true, roles: ['qa'] },
        { name: 'b', botToken: 'TB', chatId: 2, interactive: false, roles: ['digest'] },
      ],
    }));
    expect(ch).toHaveLength(2);
    expect(ch.map(c => c.name)).toEqual(['a', 'b']);
  });
});

describe('interactivePollerTokens — 토큰당 폴러 1개(dedup·409 방지)', () => {
  test('같은 토큰 여러 채널 → 폴러 1개', () => {
    const p = interactivePollerTokens([
      { name: 'main', botToken: 'T', chatId: 1, interactive: true, roles: ['qa'] },
      { name: 'alt', botToken: 'T', chatId: 2, interactive: true, roles: ['alert'] },
    ]);
    expect(p).toHaveLength(1); // 같은 토큰 T → 1개만
  });

  test('다른 토큰 → 각각 폴러 · noti-only 제외', () => {
    const p = interactivePollerTokens([
      { name: 'main', botToken: 'TA', chatId: 1, interactive: true, roles: ['qa'] },
      { name: 'alert', botToken: 'TB', chatId: 2, interactive: true, roles: ['alert'] },
      { name: 'digest', botToken: 'TC', chatId: 3, interactive: false, roles: ['digest'] }, // noti-only
    ]);
    expect(p.map(c => c.botToken)).toEqual(['TA', 'TB']); // TC 제외
  });
});

describe('channelForRole — 발송 라우팅', () => {
  const channels = resolveTelegramChannels(tg({ botToken: 'MAIN', reportChannel: { chatId: 999, botToken: 'ALERT' } }));
  test('alert 역할 → alert 채널', () => {
    expect(channelForRole(channels, 'alert')!.name).toBe('alert');
  });
  test('없는 역할 → default(main) fallback', () => {
    expect(channelForRole(channels, 'unknown')!.name).toBe('main');
  });
});
