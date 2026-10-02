import { describe, expect, test } from 'bun:test';
import { HW_KEYBOARD_KEY, isHardwareKeyEvidence, readHardwareKeyboard, writeHardwareKeyboard } from './hw-keyboard';

const ANDROID = 'Mozilla/5.0 (Linux; Android 16; SM-F971N) AppleWebKit/537.36 Chrome/141 Mobile Safari/537.36';
const IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Version/26.0 Mobile/15E148 Safari/604.1';
const k = (over: Partial<KeyboardEvent>) => ({ key: 'a', keyCode: 65, ctrlKey: false, metaKey: false, altKey: false, isComposing: false, ...over }) as KeyboardEvent;

describe('hardware keyboard evidence', () => {
  test('keys a soft keyboard cannot send count on every platform', () => {
    for (const key of ['Escape', 'Tab', 'ArrowUp', 'ArrowLeft', 'F5', 'F12']) {
      expect(isHardwareKeyEvidence(k({ key, keyCode: 27 }), IOS)).toBe(true);
      expect(isHardwareKeyEvidence(k({ key, keyCode: 27 }), ANDROID)).toBe(true);
    }
    expect(isHardwareKeyEvidence(k({ key: 'c', ctrlKey: true }), IOS)).toBe(true);
  });

  test('Android soft keyboard (229 · Unidentified · composing) is not evidence; a real letter on Android is', () => {
    expect(isHardwareKeyEvidence(k({ key: 'Unidentified', keyCode: 229 }), ANDROID)).toBe(false);
    expect(isHardwareKeyEvidence(k({ key: 'a', keyCode: 229 }), ANDROID)).toBe(false);
    expect(isHardwareKeyEvidence(k({ key: 'a', isComposing: true }), ANDROID)).toBe(false);
    expect(isHardwareKeyEvidence(k({ key: 'l', keyCode: 76 }), ANDROID)).toBe(true);
  });

  test('a plain letter on iOS is not evidence (the iOS soft keyboard sends real letters)', () => {
    expect(isHardwareKeyEvidence(k({ key: 'l', keyCode: 76 }), IOS)).toBe(false);
    expect(isHardwareKeyEvidence(k({ key: 'Enter', keyCode: 13 }), IOS)).toBe(false);
  });

  test('the finding is remembered per device and survives broken storage', () => {
    const map = new Map<string, string>();
    const storage = { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, v: string) => { map.set(key, v); } };
    expect(readHardwareKeyboard(storage)).toBe(false);
    writeHardwareKeyboard(storage, true);
    expect(map.get(HW_KEYBOARD_KEY)).toBe('1');
    expect(readHardwareKeyboard(storage)).toBe(true);
    const broken = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); } };
    expect(readHardwareKeyboard(broken)).toBe(false);
    expect(() => writeHardwareKeyboard(broken, true)).not.toThrow();
  });
});
