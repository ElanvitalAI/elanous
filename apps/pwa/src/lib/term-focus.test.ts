import { describe, expect, test } from 'bun:test';
import { TERM_FOCUS_DISABLED_KEY, TERM_FONT_DEFAULT, TERM_FONT_KEY, TERM_FONT_MAX, TERM_FONT_MIN, clampFontSize, fontStepKey, isFocusToggleKey, readTermFocusStartDisabled, readTermFontSize, writeTermFocusStartDisabled, writeTermFontSize } from './term-focus';

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

  test('font size is clamped and remembered per device; broken storage falls back to the default', () => {
    expect(clampFontSize(3)).toBe(TERM_FONT_MIN);
    expect(clampFontSize(99)).toBe(TERM_FONT_MAX);
    expect(clampFontSize(Number.NaN)).toBe(TERM_FONT_DEFAULT);
    const map = new Map<string, string>();
    const storage = { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, v: string) => { map.set(key, v); } };
    expect(readTermFontSize(storage)).toBe(TERM_FONT_DEFAULT);
    writeTermFontSize(storage, 18.4);
    expect(map.get(TERM_FONT_KEY)).toBe('18');
    expect(readTermFontSize(storage)).toBe(18);
    const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(readTermFontSize(broken)).toBe(TERM_FONT_DEFAULT);
    expect(() => writeTermFontSize(broken, 20)).not.toThrow();
  });
});
