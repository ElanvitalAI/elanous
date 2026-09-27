import { afterEach, expect, test } from 'bun:test';
import { SHARE_PREFILL_KEY, takeSharePrefill, writeSharePrefill } from './share-prefill';

const previousWindow = globalThis.window;

afterEach(() => {
  if (previousWindow === undefined) {
    delete (globalThis as { window?: Window }).window;
  } else {
    globalThis.window = previousWindow;
  }
});

test('a shared prefill is consumed exactly once', () => {
  const values = new Map<string, string>();
  const sessionStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  (globalThis as { window?: Window }).window = { sessionStorage } as unknown as Window;
  writeSharePrefill('shared question');
  expect(values.get(SHARE_PREFILL_KEY)).toBe('shared question');
  expect(takeSharePrefill()).toBe('shared question');
  expect(takeSharePrefill()).toBe('');
});
