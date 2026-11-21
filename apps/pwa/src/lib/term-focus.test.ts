import { describe, expect, test } from 'bun:test';
import { TERM_FOCUS_DISABLED_KEY, TERM_FONT_DEFAULT, TERM_FONT_KEY, TERM_FONT_MAX, TERM_FONT_MIN, clampFontSize, fontStepKey, isFocusToggleKey, publishTermFontSize, subscribeTermFontSize, readTermFocusStartDisabled, readTermFontSize, writeTermFocusStartDisabled, writeTermFontSize } from './term-focus';

const k = (over: Partial<KeyboardEvent>) => ({ key: '', code: '', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...over }) as KeyboardEvent;

describe('terminal focus mode keys', () => {
  test('Ctrl+Shift+F and ⌘+Shift+F toggle · plain F, Ctrl+F, Esc, Alt chords do not', () => {
    expect(isFocusToggleKey(k({ key: 'F', code: 'KeyF', ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(isFocusToggleKey(k({ key: 'f', code: 'KeyF', metaKey: true, shiftKey: true }))).toBe(true);
    expect(isFocusToggleKey(k({ key: 'f', code: 'KeyF' }))).toBe(false);
    expect(isFocusToggleKey(k({ key: 'f', code: 'KeyF', ctrlKey: true }))).toBe(false);
    expect(isFocusToggleKey(k({ key: 'Escape', code: 'Escape' }))).toBe(false);
    expect(isFocusToggleKey(k({ key: 'F', code: 'KeyF', ctrlKey: true, shiftKey: true, altKey: true }))).toBe(false);
  });

  test('font step keys: Ctrl/⌘+Shift + (=|+) grows, (-|_) shrinks, anything else is 0', () => {
    expect(fontStepKey(k({ key: '+', code: 'Equal', ctrlKey: true, shiftKey: true }))).toBe(1);
    expect(fontStepKey(k({ key: '_', code: 'Minus', metaKey: true, shiftKey: true }))).toBe(-1);
    expect(fontStepKey(k({ key: '+', code: 'NumpadAdd', ctrlKey: true, shiftKey: true }))).toBe(1);
    expect(fontStepKey(k({ key: '=', code: 'Equal', ctrlKey: true }))).toBe(0);
    expect(fontStepKey(k({ key: 'a', code: 'KeyA', ctrlKey: true, shiftKey: true }))).toBe(0);
  });

  test('focus start opt-out is remembered per device; missing or blocked storage defaults to enabled', () => {
    const map = new Map<string, string>();
    const storage = { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value); } };
    expect(readTermFocusStartDisabled(storage)).toBe(false);
    writeTermFocusStartDisabled(storage);
    expect(map.get(TERM_FOCUS_DISABLED_KEY)).toBe('1');
    expect(readTermFocusStartDisabled(storage)).toBe(true);
    expect(readTermFocusStartDisabled(null)).toBe(false);
    const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(readTermFocusStartDisabled(broken)).toBe(false);
    expect(() => writeTermFocusStartDisabled(broken)).not.toThrow();
  });

  test('subscriptions ignore unrelated storage and clean up; blocked storage still updates mounted listeners', () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const listeners = new Set<(event: StorageEvent) => void>();
    const fakeWindow = {
      get localStorage(): Storage { throw new Error('blocked'); },
      addEventListener: (_: string, listener: (event: StorageEvent) => void) => listeners.add(listener),
      removeEventListener: (_: string, listener: (event: StorageEvent) => void) => listeners.delete(listener),
    };
    Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });
    try {
      const a: number[] = [];
      const b: number[] = [];
      const stopA = subscribeTermFontSize((size) => a.push(size));
      const stopB = subscribeTermFontSize((size) => b.push(size));
      for (const listener of listeners) listener({ key: 'unrelated' } as StorageEvent);
      publishTermFontSize(99);
      expect(a).toEqual([TERM_FONT_DEFAULT, TERM_FONT_MAX]);
      expect(b).toEqual([TERM_FONT_DEFAULT, TERM_FONT_MAX]);
      stopA();
      publishTermFontSize(18);
      expect(a).toEqual([TERM_FONT_DEFAULT, TERM_FONT_MAX]);
      expect(b).toEqual([TERM_FONT_DEFAULT, TERM_FONT_MAX, 18]);
      stopB();
      const later: number[] = [];
      const stopLater = subscribeTermFontSize((size) => later.push(size));
      expect(later).toEqual([18]);
      stopLater();
      expect(listeners.size).toBe(0);
    } finally {
      if (previous) Object.defineProperty(globalThis, 'window', previous);
      else delete (globalThis as { window?: unknown }).window;
    }
  });

  test('a blocked storage write preserves the published size for a later subscriber', () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const storage = { getItem: () => '12', setItem: () => { throw new Error('blocked'); } };
    const fakeWindow = { localStorage: storage, addEventListener: () => {}, removeEventListener: () => {} };
    Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });
    try {
      publishTermFontSize(21);
      const values: number[] = [];
      const stop = subscribeTermFontSize((size) => values.push(size));
      expect(values).toEqual([21]);
      stop();
    } finally {
      if (previous) Object.defineProperty(globalThis, 'window', previous);
      else delete (globalThis as { window?: unknown }).window;
    }
  });

  test('font size is clamped and remembered per device; broken storage falls back to the default', () => {
    expect(clampFontSize(3)).toBe(TERM_FONT_MIN);
    expect(clampFontSize(99)).toBe(TERM_FONT_MAX);
    expect(clampFontSize(Number.NaN)).toBe(TERM_FONT_DEFAULT);
    const map = new Map<string, string>();
    const storage = { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, v: string) => { map.set(key, v); } };
    expect(readTermFontSize(storage)).toBe(TERM_FONT_DEFAULT);
    expect(readTermFontSize(storage, true)).toBe(TERM_FONT_DEFAULT + 1);
    writeTermFontSize(storage, 18.4);
    expect(readTermFontSize(storage, true)).toBe(18);
    expect(map.get(TERM_FONT_KEY)).toBe('18');
    expect(readTermFontSize(storage)).toBe(18);
    const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(readTermFontSize(broken)).toBe(TERM_FONT_DEFAULT);
    expect(() => writeTermFontSize(broken, 20)).not.toThrow();
  });
});
