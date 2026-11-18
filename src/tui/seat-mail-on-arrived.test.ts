import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { seatMailOnArrived } from './seat-mail-on-arrived.js';

const wake = { name: 'queue-wake' };

function seam(busy: boolean) {
  const injectKeys: unknown[] = [];
  const onArrived = seatMailOnArrived({
    busy: () => busy,
    injectKey: (key) => { injectKeys.push(key); },
    queueWake: wake,
  });
  return { onArrived, injectKeys };
}

test('idle arrival injects the queue wake and the leaf has no steer hook', () => {
  const s = seam(false);
  s.onArrived();
  s.onArrived();
  expect(s.injectKeys).toEqual([wake, wake]);
  const source = readFileSync(new URL('./seat-mail-on-arrived.ts', import.meta.url), 'utf8');
  expect(source.includes('steer?:')).toBe(false);
  expect(source.includes('steer(')).toBe(false);
});

test('busy arrival injects nothing', () => {
  const s = seam(true);
  s.onArrived();
  s.onArrived();
  expect(s.injectKeys).toEqual([]);
});
