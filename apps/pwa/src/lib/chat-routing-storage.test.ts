import { afterEach, expect, test } from 'bun:test';
import { DEFAULT_CHAT_ROUTING, getChatRouting, setAutoRouting, subscribeChatRouting } from './chat-routing-storage';

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else delete (globalThis as { window?: unknown }).window;
});

test('automatic routing alone persists and notifies local and cross-tab subscribers', () => {
  const values = new Map<string, string>([['legacy-ignored-preference', '1']]);
  const listeners = new Map<string, Set<(event: Event) => void>>();
  const windowStub = {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    },
    addEventListener: (name: string, fn: (event: Event) => void) => {
      const callbacks = listeners.get(name) ?? new Set();
      callbacks.add(fn);
      listeners.set(name, callbacks);
    },
    removeEventListener: (name: string, fn: (event: Event) => void) => { listeners.get(name)?.delete(fn); },
    dispatchEvent: (event: Event) => {
      for (const fn of listeners.get(event.type) ?? []) fn(event);
      return true;
    },
  };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: windowStub });
  expect(DEFAULT_CHAT_ROUTING).toEqual({ autoRouting: false });
  expect(getChatRouting()).toEqual({ autoRouting: false });
  const seen: boolean[] = [];
  const unsubscribe = subscribeChatRouting((state) => { seen.push(state.autoRouting); });
  setAutoRouting(true);
  expect(getChatRouting()).toEqual({ autoRouting: true });
  expect(values.get('elanous.pwa.chat.autoRouting')).toBe('1');
  windowStub.dispatchEvent(Object.assign(new Event('storage'), { key: 'legacy-ignored-preference' }));
  expect(seen).toEqual([true]);
  windowStub.dispatchEvent(Object.assign(new Event('storage'), { key: 'elanous.pwa.chat.autoRouting' }));
  expect(seen).toEqual([true, true]);
  unsubscribe();
  setAutoRouting(false);
  expect(seen).toEqual([true, true]);
});
