// PWA service worker registration helper — unit tests.
//
// We can't drive the real `navigator.serviceWorker` API from bun
// (no jsdom · no real browser). Instead we stub the global navigator
// + window enough to verify the helper's branching:
//   - SSR safety (no window/navigator)
//   - missing serviceWorker API
//   - insecure context
//   - register success (registered)
//   - register success with waiting (updateAvailable)
//   - register failure (error)
//
// The actual SW lifecycle (install/activate/fetch) is browser-only;
// dogfood verification is captured in the PR description.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  registerServiceWorker,
  postSkipWaiting,
  _resetRegisterSwCache,
} from './register-sw';

const realWindow = (globalThis as { window?: unknown }).window;
const realNavigator = (globalThis as { navigator?: unknown }).navigator;

interface FakeSWRegistration {
  scope: string;
  waiting: { postMessage: (msg: unknown) => void } | null;
  installing: unknown;
  addEventListener: (event: string, cb: () => void) => void;
}

function setWindow(value: unknown): void {
  Object.defineProperty(globalThis, 'window', {
    value,
    configurable: true,
    writable: true,
  });
}

function setNavigator(value: unknown): void {
  Object.defineProperty(globalThis, 'navigator', {
    value,
    configurable: true,
    writable: true,
  });
}

beforeEach(() => {
  _resetRegisterSwCache();
});

afterEach(() => {
  setWindow(realWindow);
  setNavigator(realNavigator);
});

describe('registerServiceWorker — guards', () => {
  test('SSR — returns unsupported when window absent', async () => {
    setWindow(undefined);
    const r = await registerServiceWorker();
    expect(r.status).toBe('unsupported');
    if (r.status !== 'unsupported') throw new Error('unreachable');
    expect(r.reason).toContain('SSR');
  });

  test('returns unsupported when navigator.serviceWorker absent', async () => {
    setWindow({ isSecureContext: true });
    setNavigator({}); // no serviceWorker
    const r = await registerServiceWorker();
    expect(r.status).toBe('unsupported');
    if (r.status !== 'unsupported') throw new Error('unreachable');
    expect(r.reason).toContain('serviceWorker');
  });

  test('returns unsupported when context is insecure', async () => {
    setWindow({ isSecureContext: false });
    setNavigator({ serviceWorker: { register: async () => {} } });
    const r = await registerServiceWorker();
    expect(r.status).toBe('unsupported');
    if (r.status !== 'unsupported') throw new Error('unreachable');
    expect(r.reason).toContain('secure');
  });
});

describe('registerServiceWorker — bare webchat origin', () => {
  test('never registers the service worker the bare host does not serve', async () => {
    setWindow({ isSecureContext: true });
    const registered: string[] = [];
    setNavigator({ serviceWorker: { register: async (path: string) => { registered.push(path); } } });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { querySelector: () => ({ getAttribute: () => '1' }) } });
    try {
      const r = await registerServiceWorker();
      expect(r.status).toBe('unsupported');
      expect(registered).toEqual([]);
    } finally { delete (globalThis as { document?: unknown }).document; }
  });
});

describe('registerServiceWorker — success paths', () => {
  test('registered with no waiting → updateAvailable=false', async () => {
    setWindow({ isSecureContext: true });
    const fakeReg: FakeSWRegistration = {
      scope: 'https://example.com/app/',
      waiting: null,
      installing: null,
      addEventListener: () => { /* no-op */ },
    };
    setNavigator({
      serviceWorker: {
        register: async (path: string, opts: { scope: string }) => {
          expect(path).toBe('/app/sw.js');
          expect(opts.scope).toBe('/app/');
          return fakeReg;
        },
      },
    });
    const r = await registerServiceWorker();
    expect(r.status).toBe('registered');
    if (r.status !== 'registered') throw new Error('unreachable');
    expect(r.scope).toBe('https://example.com/app/');
    expect(r.updateAvailable).toBe(false);
  });

  test('registered with waiting SW → updateAvailable=true', async () => {
    setWindow({ isSecureContext: true });
    const fakeReg: FakeSWRegistration = {
      scope: '/app/',
      waiting: { postMessage: () => { /* no-op */ } },
      installing: null,
      addEventListener: () => { /* no-op */ },
    };
    setNavigator({
      serviceWorker: { register: async () => fakeReg },
    });
    const r = await registerServiceWorker();
    expect(r.status).toBe('registered');
    if (r.status !== 'registered') throw new Error('unreachable');
    expect(r.updateAvailable).toBe(true);
  });

  test('register throws → status=error with reason', async () => {
    setWindow({ isSecureContext: true });
    setNavigator({
      serviceWorker: {
        register: async () => { throw new Error('boom — invalid scope'); },
      },
    });
    const r = await registerServiceWorker();
    expect(r.status).toBe('error');
    if (r.status !== 'error') throw new Error('unreachable');
    expect(r.reason).toContain('boom');
  });
});

describe('postSkipWaiting', () => {
  test('no-op when no registration cached', () => {
    // Just verify it doesn't throw.
    expect(() => postSkipWaiting()).not.toThrow();
  });

  test('posts {type:SKIP_WAITING} to the waiting SW after register', async () => {
    setWindow({ isSecureContext: true });
    let posted: unknown = null;
    const fakeReg: FakeSWRegistration = {
      scope: '/app/',
      waiting: { postMessage: (msg: unknown) => { posted = msg; } },
      installing: null,
      addEventListener: () => { /* no-op */ },
    };
    setNavigator({
      serviceWorker: { register: async () => fakeReg },
    });
    await registerServiceWorker();
    postSkipWaiting();
    expect(posted).toEqual({ type: 'SKIP_WAITING' });
  });
});
