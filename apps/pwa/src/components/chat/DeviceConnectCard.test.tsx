import { afterEach, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { DeviceConnectCard } from './DeviceConnectCard';
import { authRequiredNow, reportAuthRequired, resetAuthRequiredForTests } from '@/lib/auth-required';

afterEach(() => resetAuthRequiredForTests());

describe('WEB-CHAT-ACTIVITY-ERROR · device connect card', () => {
  test('one card says the device must be connected and how (connect link, else a token in Settings)', () => {
    const html = renderToStaticMarkup(<DeviceConnectCard />);
    expect(html).toContain('이 기기를 연결해야 합니다');
    expect(html).toContain('eln nexus pwa connect-link');
    expect(html).toContain('href="/settings"');
    expect(html).toContain('role="alert"');
  });

  test('the first 401 marks the device as not connected', () => {
    expect(authRequiredNow()).toBe(false);
    const previous = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = { dispatchEvent: () => true } as unknown;
    try {
      reportAuthRequired('/v1/terminals');
      expect(authRequiredNow()).toBe(true);
    } finally {
      (globalThis as { window?: unknown }).window = previous;
    }
  });
});
