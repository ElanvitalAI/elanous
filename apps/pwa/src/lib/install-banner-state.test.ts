import { describe, expect, it, spyOn } from 'bun:test';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import * as realNavigation from 'next/navigation';

import {
  __INTERNAL_RESHOW_MS,
  detectPlatform,
  quietFor,
  shouldShow,
} from './install-banner-state';

import { InstallBanner } from '../components/install-banner';

describe('detectPlatform', () => {
  it('returns beforeInstallPromptCapable when the event handle is present', () => {
    expect(detectPlatform('Mozilla/5.0 …', true)).toBe('beforeInstallPromptCapable');
  });

  it('returns iosSafari for iPhone Safari', () => {
    const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605 Version/17.0 Mobile/15E148 Safari/604.1';
    expect(detectPlatform(ua, false)).toBe('iosSafari');
  });

  it('returns iosSafari for iPad Safari', () => {
    const ua = 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605 Version/17.0 Mobile/15E148 Safari/604.1';
    expect(detectPlatform(ua, false)).toBe('iosSafari');
  });

  it('does not classify Chrome-on-iOS as iosSafari (no manual install path)', () => {
    const ua = 'Mozilla/5.0 (iPhone; …) CriOS/120.0.0.0 Mobile/15E148 Safari/604.1';
    expect(detectPlatform(ua, false)).toBe('unsupported');
  });

  it('returns unsupported for desktop Chrome without beforeinstallprompt', () => {
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537 Chrome/120 Safari/537';
    expect(detectPlatform(ua, false)).toBe('unsupported');
  });

  it('returns unsupported on missing/empty UA', () => {
    expect(detectPlatform(undefined, false)).toBe('unsupported');
    expect(detectPlatform('', false)).toBe('unsupported');
  });
});

describe('quietFor', () => {
  const url = (path: string) => `https://example.com${path}`;

  it('hides for public capture on any route', () => {
    expect(quietFor(url('/app/chat/?capture=public'), null)).toBe(true);
  });
  it('hides for inside demo on both inside routes, including trailing slash', () => {
    expect(quietFor(url('/app/inside/?demo=1'), null)).toBe(true);
    expect(quietFor(url('/inside?demo=1'), null)).toBe(true);
    expect(quietFor(url('/app/inside/'), '1')).toBe(true);
  });
  it('lets an explicit demo=0 override storage and does not hide other routes', () => {
    expect(quietFor(url('/app/inside/?demo=0'), '1')).toBe(false);
    expect(quietFor(url('/app/chat/?demo=1'), '1')).toBe(false);
    expect(quietFor(url('/inside'), null)).toBe(false);
  });
});

describe('shouldShow', () => {
  const now = 1_700_000_000_000;

  it('quiet takes precedence over standalone, platform and dismissal', () => {
    expect(shouldShow({ now, quiet: true, standalone: true, platform: 'unsupported', dismissedAt: now }))
      .toEqual({ show: false, reason: 'quiet' });
  });

  it('shows when not standalone, supported, never dismissed', () => {
    expect(shouldShow({
      now,
      standalone: false,
      platform: 'iosSafari',
      dismissedAt: null,
    })).toEqual({ show: true, reason: 'show' });
  });

  it('hides when standalone — already installed', () => {
    expect(shouldShow({
      now,
      standalone: true,
      platform: 'iosSafari',
      dismissedAt: null,
    })).toEqual({ show: false, reason: 'standalone' });
  });

  it('hides when platform is unsupported', () => {
    expect(shouldShow({
      now,
      standalone: false,
      platform: 'unsupported',
      dismissedAt: null,
    })).toEqual({ show: false, reason: 'unsupported' });
  });

  it('hides when dismissed within the reshow window', () => {
    expect(shouldShow({
      now,
      standalone: false,
      platform: 'beforeInstallPromptCapable',
      dismissedAt: now - 1000,
    })).toEqual({ show: false, reason: 'recently-dismissed' });
  });

  it('reshows once the dismiss is older than 7 days', () => {
    expect(shouldShow({
      now,
      standalone: false,
      platform: 'beforeInstallPromptCapable',
      dismissedAt: now - __INTERNAL_RESHOW_MS - 1,
    })).toEqual({ show: true, reason: 'show' });
  });

  it('treats dismiss exactly at the window boundary as still dismissed', () => {
    expect(shouldShow({
      now,
      standalone: false,
      platform: 'iosSafari',
      dismissedAt: now - __INTERNAL_RESHOW_MS + 1,
    })).toEqual({ show: false, reason: 'recently-dismissed' });
  });
});

it('mounted InstallBanner follows query-only capture and demo transitions and the inside-demo event', () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const originalAct = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  let tree: ReactTestRenderer | undefined;
  let stored: string | null = null;
  let pathname = '/app/inside/';
  let search = new URLSearchParams();
  const handlers = new Map<string, () => void>();
  const pathSpy = spyOn(realNavigation, 'usePathname').mockImplementation(() => pathname);
  const searchSpy = spyOn(realNavigation, 'useSearchParams').mockImplementation(() => search as ReturnType<typeof realNavigation.useSearchParams>);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    location: { get href() { return `https://example.test${pathname}?${search}`; } },
    localStorage: { getItem: () => stored },
    matchMedia: () => ({ matches: false }),
    navigator: { userAgent: 'Mozilla/5.0 (iPhone) AppleWebKit/605 Mobile Safari/604' },
    addEventListener: (name: string, fn: () => void) => handlers.set(name, fn),
    removeEventListener: (name: string) => handlers.delete(name),
  } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: window.navigator });
  try {
    act(() => { tree = create(createElement(InstallBanner)); });
    const shown = () => JSON.stringify(tree!.toJSON()).includes('install-banner');
    expect(shown()).toBe(true);
    search = new URLSearchParams('capture=public');
    act(() => tree!.update(createElement(InstallBanner)));
    expect(shown()).toBe(false);
    search = new URLSearchParams();
    act(() => tree!.update(createElement(InstallBanner)));
    expect(shown()).toBe(true);
    search = new URLSearchParams('demo=1');
    act(() => tree!.update(createElement(InstallBanner)));
    expect(shown()).toBe(false);
    search = new URLSearchParams('demo=0');
    act(() => tree!.update(createElement(InstallBanner)));
    expect(shown()).toBe(true);
    search = new URLSearchParams();
    stored = '1';
    act(() => handlers.get('elanous:inside-demo')?.());
    expect(shown()).toBe(false);
    stored = '0';
    act(() => handlers.get('elanous:inside-demo')?.());
    expect(shown()).toBe(true);
  } finally {
    if (tree) act(() => tree!.unmount());
    pathSpy.mockRestore();
    searchSpy.mockRestore();
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else delete (globalThis as { window?: Window }).window;
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else delete (globalThis as { navigator?: Navigator }).navigator;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = originalAct;
  }
});
