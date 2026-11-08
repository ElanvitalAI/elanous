// M1-2 (PLAN-friction-free-model-selection-ux-2026-05-12 · Phase 1) —
// localStorage round-trip + clamping for the STT tier slider.

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import {
  DEFAULT_MODEL_TIER_PREFS,
  activeSttTier,
  loadModelTierPrefs,
  resetModelTierPrefs,
  saveModelTierPrefs,
} from './model-tier-prefs';

const KEY = 'elanous.model-tier.prefs';

// Minimal browser-like localStorage shim — bun:test runs in node so
// `window`/`localStorage` are absent by default.
function installLocalStorage(): void {
  const store = new Map<string, string>();
  const ls = {
    getItem(k: string) { return store.has(k) ? store.get(k)! : null; },
    setItem(k: string, v: string) { store.set(k, v); },
    removeItem(k: string) { store.delete(k); },
    clear() { store.clear(); },
    key(i: number) { return Array.from(store.keys())[i] ?? null; },
    get length() { return store.size; },
  };
  // Bun ships `globalThis.window`/`localStorage` undefined by default
  // — installing them at the global scope is enough for the module's
  // SSR guards to flip to "browser" mode.
  (globalThis as unknown as { window: object }).window = {};
  (globalThis as unknown as { localStorage: Storage }).localStorage = ls as Storage;
}

function uninstallLocalStorage(): void {
  delete (globalThis as unknown as { window?: object }).window;
  delete (globalThis as unknown as { localStorage?: Storage }).localStorage;
}

describe('M1-2 · loadModelTierPrefs · SSR-safe', () => {
  test('no window → returns defaults', () => {
    uninstallLocalStorage();
    expect(loadModelTierPrefs()).toEqual(DEFAULT_MODEL_TIER_PREFS);
  });
});

describe('M1-2 · localStorage round-trip', () => {
  beforeEach(() => {
    installLocalStorage();
    localStorage.removeItem(KEY);
  });
  afterEach(() => {
    // M2-2b-v2 cleanup — without this the globalThis.window shim
    // leaks into sibling SSR-safety tests (peer-id) running after.
    uninstallLocalStorage();
  });

  test('empty store → defaults · activeSttTier falls back to balanced', () => {
    const prefs = loadModelTierPrefs();
    expect(prefs.stt).toBeUndefined();
    expect(activeSttTier(prefs)).toBe('balanced');
  });

  test('saveModelTierPrefs persists tier + reload reads it back', () => {
    saveModelTierPrefs({ stt: 'best' });
    const prefs = loadModelTierPrefs();
    expect(prefs.stt).toBe('best');
    expect(activeSttTier(prefs)).toBe('best');
  });

  test('save merges with current (audioMinPerDay survives tier change)', () => {
    saveModelTierPrefs({ audioMinPerDay: 12 });
    saveModelTierPrefs({ stt: 'loaded' });
    const prefs = loadModelTierPrefs();
    expect(prefs.stt).toBe('loaded');
    expect(prefs.audioMinPerDay).toBe(12);
  });

  test('invalid tier value dropped to undefined on read', () => {
    localStorage.setItem(KEY, JSON.stringify({ stt: 'ultra', audioMinPerDay: 5 }));
    const prefs = loadModelTierPrefs();
    expect(prefs.stt).toBeUndefined();
    expect(prefs.audioMinPerDay).toBe(5);
  });

  test('drops embedding and vision tiers from the PWA preference schema', () => {
    localStorage.setItem(KEY, JSON.stringify({
      stt: 'best', embedding: 'loaded', vision: 'best', audioMinPerDay: 4,
    }));
    const prefs = loadModelTierPrefs();
    expect(prefs.stt).toBe('best');
    expect(prefs).not.toHaveProperty('embedding');
    expect(prefs).not.toHaveProperty('vision');

    saveModelTierPrefs({ llm: 'balanced' });
    const persisted = JSON.parse(localStorage.getItem(KEY)!);
    expect(persisted).not.toHaveProperty('embedding');
    expect(persisted).not.toHaveProperty('vision');
  });

  test('negative audioMinPerDay clamped to 0', () => {
    saveModelTierPrefs({ audioMinPerDay: -10 });
    expect(loadModelTierPrefs().audioMinPerDay).toBe(0);
  });

  test('absurd audioMinPerDay capped at 24h/day (recorder bug defense)', () => {
    saveModelTierPrefs({ audioMinPerDay: 1_000_000 });
    expect(loadModelTierPrefs().audioMinPerDay).toBe(24 * 60);
  });

  test('corrupt JSON returns defaults · does not throw', () => {
    localStorage.setItem(KEY, '{ not valid json');
    const prefs = loadModelTierPrefs();
    expect(prefs).toEqual(DEFAULT_MODEL_TIER_PREFS);
  });

  test('resetModelTierPrefs clears storage', () => {
    saveModelTierPrefs({ stt: 'best', audioMinPerDay: 20 });
    expect(localStorage.getItem(KEY)).not.toBeNull();
    resetModelTierPrefs();
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(loadModelTierPrefs()).toEqual(DEFAULT_MODEL_TIER_PREFS);
  });
});
