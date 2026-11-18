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

describe('ELN-SEAT-IDLE-QUEUE-STALL — a knock that does not reach the loop is an event', () => {
  function logged(busy: boolean, accepted: boolean) {
    const events: Array<[string, Record<string, unknown>]> = [];
    const idle = createIdleWakeDoor({
      busy: () => busy,
      injectKey: () => accepted,
      queueWake: { name: 'queueWake' },
      log: (event, data) => { events.push([event, data]); },
    });
    idle.register({ id: 'seat-mail' });
    return { idle, events };
  }

  test('busy → deferred event with the source', () => {
    const { idle, events } = logged(true, true);
    expect(idle.knock('seat-mail')).toBe(false);
    expect(events).toEqual([['wake-knock-deferred', { source: 'seat-mail' }]]);
  });

  test('terminal refused the key → refused event, knock reports false', () => {
    const { idle, events } = logged(false, false);
    expect(idle.knock('seat-mail')).toBe(false);
    expect(events).toEqual([['wake-knock-refused', { source: 'seat-mail' }]]);
  });

  test('unregistered source → event, no key', () => {
    const { idle, events } = logged(false, true);
    expect(idle.knock('wakeup')).toBe(false);
    expect(events).toEqual([['wake-knock-unregistered', { source: 'wakeup' }]]);
  });

  test('accepted idle knock → no event', () => {
    const { idle, events } = logged(false, true);
    expect(idle.knock('seat-mail')).toBe(true);
    expect(events).toEqual([]);
  });
});
