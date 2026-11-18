import { describe, expect, test } from 'bun:test';
import { createIdleWakeDoor } from './idle-wake-door.js';

const SOURCES = [
  { id: 'self-pull' },
  { id: 'graph-node' },
  { id: 'seat-mail' },
  { id: 'external-event' },
] as const;

function door(busy = false) {
  const keys: unknown[] = [];
  const wake = { name: 'queueWake' };
  const idle = createIdleWakeDoor({
    busy: () => busy,
    injectKey: (key) => { keys.push(key); },
    queueWake: wake,
  });
  for (const source of SOURCES) idle.register(source);
  return { idle, keys, wake };
}

describe('idle wake single door', () => {
  test('an idle knock from any registered source fires the one key', () => {
    const { idle, keys, wake } = door(false);
    expect(idle.knock('seat-mail')).toBe(true);
    expect(idle.knock('external-event')).toBe(true);
    expect(keys).toEqual([wake, wake]);
  });

  test('a busy seat keeps the notice and does not knock', () => {
    const { idle, keys } = door(true);
    expect(idle.knock('self-pull')).toBe(false);
    expect(idle.knock('graph-node')).toBe(false);
    expect(keys).toEqual([]);
  });

  test('an unregistered source never knocks', () => {
    const { idle, keys } = door(false);
    expect(idle.knock('wakeup')).toBe(false);
    expect(keys).toEqual([]);
  });
});
