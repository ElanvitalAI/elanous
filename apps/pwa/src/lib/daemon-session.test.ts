// Image-pipeline followup #2 helper test (2026-05-05) — verify the
// localStorage-backed sessionId helpers used by DaemonProvider's
// cross-tab `storage` listener path.
//
// Run via `bun test` from repo root (apps/pwa is included in the
// global test pickup; see upload-attachment.test.ts for precedent).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  clearSession,
  ensureSessionId,
  forkSession,
  generateSessionId,
  loadSessionId,
} from './daemon-session';

const STORAGE_KEY = 'elanous.daemon.sessionId';

// Fake the bare minimum of `window` + `localStorage` + `crypto` that
// the helpers touch. Bun ships a global `crypto.randomUUID`, so we
// only need to stub the storage + URL.
function withFakeWindow(href: string): { restore: () => void; store: Record<string, string> } {
  const store: Record<string, string> = {};
  const fakeStorage = {
    getItem: (k: string) => (k in store ? store[k]! : null),
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
    clear: () => { for (const k of Object.keys(store)) delete store[k]; },
    key: (i: number) => Object.keys(store)[i] ?? null,
    get length() { return Object.keys(store).length; },
  };
  const realWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const realStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: {
    location: { search: href.includes('?') ? '?' + href.split('?')[1] : '' },
  } });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: fakeStorage });
  return {
    store,
    restore: () => {
      if (realWindow) Object.defineProperty(globalThis, 'window', realWindow);
      else Reflect.deleteProperty(globalThis, 'window');
      if (realStorage) Object.defineProperty(globalThis, 'localStorage', realStorage);
      else Reflect.deleteProperty(globalThis, 'localStorage');
    },
  };
}

describe('daemon-session helpers', () => {
  let env: ReturnType<typeof withFakeWindow>;

  beforeEach(() => {
    env = withFakeWindow('/');
  });
  afterEach(() => {
    env.restore();
  });

  test('generateSessionId returns a non-empty string', () => {
    const id = generateSessionId();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
    // UUID v4-ish or fallback — just verify shape isn't blank.
    expect(id.trim()).toBe(id);
  });

  test('loadSessionId returns null when storage is empty', () => {
    expect(loadSessionId()).toBeNull();
  });

  test('loadSessionId reads a previously persisted id', () => {
    env.store[STORAGE_KEY] = 'abc-123';
    expect(loadSessionId()).toBe('abc-123');
  });

  test('ensureSessionId persists a fresh id when storage was empty', () => {
    expect(env.store[STORAGE_KEY]).toBeUndefined();
    const id = ensureSessionId();
    expect(id).toBeTruthy();
    expect(env.store[STORAGE_KEY]).toBe(id);
    // Idempotent — second call returns the same id.
    expect(ensureSessionId()).toBe(id);
  });

  test('forkSession overwrites the persisted id and returns the new one', () => {
    env.store[STORAGE_KEY] = 'old-id';
    const next = forkSession();
    expect(next).not.toBe('old-id');
    expect(env.store[STORAGE_KEY]).toBe(next);
  });

  test('clearSession removes the persisted id', () => {
    env.store[STORAGE_KEY] = 'some-id';
    clearSession();
    expect(env.store[STORAGE_KEY]).toBeUndefined();
  });

  test('URL ?session= override wins on load + persists for next call', () => {
    env.restore();
    env = withFakeWindow('/?session=url-injected-id');
    expect(loadSessionId()).toBe('url-injected-id');
    expect(env.store[STORAGE_KEY]).toBe('url-injected-id');
  });
});
