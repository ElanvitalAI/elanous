import { describe, expect, test } from 'bun:test';
import { encodeReportOriginEnv, formatPtyLinkMessage, readReportOrigin } from './report-origin.js';

describe('report origin', () => {
  test('round-trips telegram origin through the environment', () => {
    const origin = { channel: 'telegram' as const, chatId: -100123, botId: 'bot-1', threadId: 7 };
    expect(readReportOrigin(encodeReportOriginEnv(origin))).toEqual(origin);
  });

  test('missing, malformed and invalid origins do not throw or create a destination', () => {
    expect(readReportOrigin({})).toBeNull();
    expect(readReportOrigin({ ELANOUS_REPORT_ORIGIN: '{broken' })).toBeNull();
    expect(readReportOrigin({ ELANOUS_REPORT_ORIGIN: JSON.stringify({ channel: 'telegram' }) })).toBeNull();
    expect(readReportOrigin({ ELANOUS_REPORT_ORIGIN: JSON.stringify({ channel: 'unknown', chatId: 4 }) })).toBeNull();
  });

  test('message contains the link and read-only takeover instruction', () => {
    const message = formatPtyLinkMessage({ webUrl: 'https://host/term?pty=self_12345678', ptyId: 'self_12345678', title: '빌드' });
    expect(message).toContain('https://host/term?pty=self_12345678');
    expect(message).toContain('takeover');
    expect(message).toContain('읽기 전용');
    expect(message.split('\n')).toHaveLength(2);
  });
});
