import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { ChatRoutingCard } from './ChatRoutingCard';
import { getChatRouting } from '@/lib/chat-routing-storage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

test('only automatic routing can be toggled and the choice is persisted', async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const values = new Map<string, string>();
  const listeners = new Map<string, Set<(event: Event) => void>>();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    },
    addEventListener: (type: string, listener: (event: Event) => void) => {
      const group = listeners.get(type) ?? new Set();
      group.add(listener);
      listeners.set(type, group);
    },
    removeEventListener: (type: string, listener: (event: Event) => void) => {
      listeners.get(type)?.delete(listener);
    },
    dispatchEvent: (event: Event) => {
      for (const listener of listeners.get(event.type) ?? []) listener(event);
    },
  } });
  let tree: ReturnType<typeof create> | undefined;
  try {
    await act(async () => { tree = create(createElement(ChatRoutingCard)); });
    const toggles = tree!.root.findAllByType('input');
    expect(toggles).toHaveLength(1);
    expect(JSON.stringify(tree!.toJSON())).toContain('Automatic routing');
    expect(toggles[0]!.props.checked).toBe(false);
    await act(async () => { toggles[0]!.props.onChange({ target: { checked: true } }); });
    expect(getChatRouting()).toEqual({ autoRouting: true });
    expect(tree!.root.findByType('input').props.checked).toBe(true);
  } finally {
    if (tree) act(() => { tree!.unmount(); });
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else delete (globalThis as { window?: unknown }).window;
  }
});
