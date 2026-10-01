import { afterEach, describe, expect, test } from 'bun:test';
import { PWA_ROLE_EVENT, PWA_ROLE_KEY, readPwaRole, usePwaRole, writePwaRole } from './pwa-role';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { createElement } from 'react';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const originalWindow = globalThis.window;
afterEach(() => { globalThis.window = originalWindow; });

describe('local PWA role', () => {
  test('MAT2 — no browser, absent or unrecognized stored value defaults to general; a stored owner stays owner', () => {
    expect(readPwaRole()).toBe('general');
    let saved: string | null = null;
    globalThis.window = { localStorage: { getItem: () => saved } } as unknown as Window & typeof globalThis;
    expect(readPwaRole()).toBe('general');
    saved = 'unknown';
    expect(readPwaRole()).toBe('general');
    saved = 'owner';
    expect(readPwaRole()).toBe('owner');
    saved = 'contributor';
    expect(readPwaRole()).toBe('contributor');
    saved = 'general';
    expect(readPwaRole()).toBe('general');
  });

  test('writing persists on this device and notifies the same window', () => {
    let stored = '';
    const events: string[] = [];
    globalThis.window = {
      localStorage: {
        getItem: () => stored,
        setItem: (key: string, value: string) => { expect(key).toBe(PWA_ROLE_KEY); stored = value; },
      },
      dispatchEvent: (event: Event) => { events.push(event.type); return true; },
    } as unknown as Window & typeof globalThis;
    writePwaRole('general');
    expect(readPwaRole()).toBe('general');
    writePwaRole('owner');
    expect(readPwaRole()).toBe('owner');
    expect(events).toEqual([PWA_ROLE_EVENT, PWA_ROLE_EVENT]);
  });

  test('a storage event from another tab updates mounted role readers', async () => {
    let saved = 'owner';
    const handlers = new Map<string, Set<(event: Event) => void>>();
    globalThis.window = {
      localStorage: { getItem: () => saved },
      addEventListener: (name: string, handler: (event: Event) => void) => {
        if (!handlers.has(name)) handlers.set(name, new Set());
        handlers.get(name)!.add(handler);
      },
      removeEventListener: (name: string, handler: (event: Event) => void) => { handlers.get(name)?.delete(handler); },
    } as unknown as Window & typeof globalThis;
    const Role = () => createElement('span', null, usePwaRole());
    let tree!: ReactTestRenderer;
    try {
      await act(async () => { tree = create(createElement(Role)); });
      expect(tree.root.findByType('span').props.children).toBe('owner');
      saved = 'general';
      await act(async () => {
        for (const handler of handlers.get('storage') ?? []) handler({ type: 'storage', key: PWA_ROLE_KEY } as StorageEvent);
      });
      expect(tree.root.findByType('span').props.children).toBe('general');
      saved = 'contributor';
      await act(async () => {
        for (const handler of handlers.get('storage') ?? []) handler({ type: 'storage', key: null } as StorageEvent);
      });
      expect(tree.root.findByType('span').props.children).toBe('contributor');
    } finally {
      await act(async () => { tree.unmount(); });
      expect(handlers.get('storage')?.size).toBe(0);
    }
  });

  test('blocked storage keeps the general fallback and still notifies', () => {
    const events: string[] = [];
    globalThis.window = {
      localStorage: {
        getItem: () => { throw new Error('blocked'); },
        setItem: () => { throw new Error('blocked'); },
      },
      dispatchEvent: (event: Event) => { events.push(event.type); return true; },
    } as unknown as Window & typeof globalThis;
    writePwaRole('owner');
    expect(readPwaRole()).toBe('general');
    expect(events).toEqual([PWA_ROLE_EVENT]);
  });
});
