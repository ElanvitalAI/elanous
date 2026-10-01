import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { clearSetupScope, loadDaemonConfig, readSetupScope, saveDaemonConfig } from './daemon-config';

declare const globalThis: {
  window?: unknown;
  localStorage?: Storage;
};

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

interface FakeWindow {
  location: { protocol: string; host: string };
}

describe('daemon-config — NEXUS PR a (v6) baseUrl cutover', () => {
  let prevWindow: unknown;
  let prevStorage: Storage | undefined;

  beforeEach(() => {
    prevWindow = globalThis.window;
    prevStorage = globalThis.localStorage;
    const fake: FakeWindow = {
      location: { protocol: 'https:', host: 'mbp.tailnet.ts.net:31415' },
    };
    globalThis.window = fake;
    globalThis.localStorage = new MemoryStorage();
  });

  afterEach(() => {
    globalThis.window = prevWindow as never;
    if (prevStorage) globalThis.localStorage = prevStorage;
    else delete globalThis.localStorage;
  });

  test('loads nexus baseUrl when present', () => {
    localStorage.setItem('elanous.nexus.baseUrl', 'https://nexus.example:31415');
    localStorage.setItem('elanous.daemon.token', 't0');
    const cfg = loadDaemonConfig();
    expect(cfg.baseUrl).toBe('https://nexus.example:31415');
    expect(cfg.token).toBe('t0');
  });

  test('migrates legacy elanous.daemon.baseUrl → elanous.nexus.baseUrl on first load', () => {
    localStorage.setItem('elanous.daemon.baseUrl', 'https://daemon.example:31415');
    const cfg = loadDaemonConfig();
    expect(cfg.baseUrl).toBe('https://daemon.example:31415');
    expect(localStorage.getItem('elanous.nexus.baseUrl')).toBe('https://daemon.example:31415');
    expect(localStorage.getItem('elanous.daemon.baseUrl')).toBeNull();
  });

  test('nexus key wins over legacy daemon key (no overwrite)', () => {
    localStorage.setItem('elanous.nexus.baseUrl', 'https://current.example');
    localStorage.setItem('elanous.daemon.baseUrl', 'https://stale.example');
    const cfg = loadDaemonConfig();
    expect(cfg.baseUrl).toBe('https://current.example');
    // The stale legacy key is left alone so any *other* downstream that
    // hasn't migrated yet still sees the previous value (we only touch
    // the legacy key when it's the migration source).
    expect(localStorage.getItem('elanous.daemon.baseUrl')).toBe('https://stale.example');
  });

  test('migrates legacy elanous.voice.wsUrl → elanous.nexus.baseUrl via URL transform', () => {
    localStorage.setItem('elanous.voice.wsUrl', 'wss://mbp.tailnet.ts.net:31415/v1/voice/ws');
    const cfg = loadDaemonConfig();
    expect(cfg.baseUrl).toBe('https://mbp.tailnet.ts.net:31415');
    expect(localStorage.getItem('elanous.voice.wsUrl')).toBeNull();
  });

  test('legacy daemon baseUrl precedes legacy voice wsUrl when both present', () => {
    localStorage.setItem('elanous.daemon.baseUrl', 'https://daemon.example:31415');
    localStorage.setItem('elanous.voice.wsUrl', 'wss://voice.example:31415/v1/voice/ws');
    const cfg = loadDaemonConfig();
    expect(cfg.baseUrl).toBe('https://daemon.example:31415');
    // Voice key is left in place since the daemon migration ran first
    // and consumed the slot — second migrate sees currentKey populated
    // and skips, so legacy voice key is untouched.
    expect(localStorage.getItem('elanous.voice.wsUrl')).toBe('wss://voice.example:31415/v1/voice/ws');
    expect(localStorage.getItem('elanous.daemon.baseUrl')).toBeNull();
  });

  test('migrates legacy voice token → daemon token slot', () => {
    localStorage.setItem('elanous.voice.token', 'voice-tok');
    const cfg = loadDaemonConfig();
    expect(cfg.token).toBe('voice-tok');
  });

  test('falls back to window.location origin when no stored baseUrl', () => {
    const cfg = loadDaemonConfig();
    expect(cfg.baseUrl).toBe('https://mbp.tailnet.ts.net:31415');
  });

  test('saveDaemonConfig writes to nexus key', () => {
    saveDaemonConfig({ baseUrl: 'https://new.example', token: 't1' });
    expect(localStorage.getItem('elanous.nexus.baseUrl')).toBe('https://new.example');
    expect(localStorage.getItem('elanous.daemon.token')).toBe('t1');
  });

  test('reads a future setup-scope expiry without changing bearer or config', () => {
    const expiresAt = Date.now() + 60_000;
    localStorage.setItem('elanous.daemon.setupScopeExpiresAt', String(expiresAt));
    saveDaemonConfig({ baseUrl: 'https://nexus.example', token: 'bearer', provider: 'claude' });
    expect(readSetupScope()).toBe(expiresAt);
    expect(loadDaemonConfig()).toEqual({
      baseUrl: 'https://nexus.example', token: 'bearer', provider: 'claude',
    });
  });

  test('rejects expired or invalid setup-scope expiry and removes only its key', () => {
    localStorage.setItem('elanous.daemon.token', 'bearer');
    for (const raw of [String(Date.now() - 1), 'not-a-date', 'Infinity', '']) {
      localStorage.setItem('elanous.daemon.setupScopeExpiresAt', raw);
      expect(readSetupScope()).toBeNull();
      expect(localStorage.getItem('elanous.daemon.setupScopeExpiresAt')).toBeNull();
      expect(localStorage.getItem('elanous.daemon.token')).toBe('bearer');
    }
  });

  test('clears only setup-scope expiry, including when it is absent', () => {
    localStorage.setItem('elanous.daemon.setupScopeExpiresAt', String(Date.now() + 60_000));
    localStorage.setItem('elanous.daemon.token', 'bearer');
    clearSetupScope();
    clearSetupScope();
    expect(readSetupScope()).toBeNull();
    expect(localStorage.getItem('elanous.daemon.token')).toBe('bearer');
  });

  test('SSR (no window) yields empty config and no setup scope', () => {
    delete (globalThis as { window?: unknown }).window;
    const cfg = loadDaemonConfig();
    expect(cfg).toEqual({ baseUrl: '', token: '', provider: '' });
    expect(readSetupScope()).toBeNull();
    clearSetupScope();
  });
});
