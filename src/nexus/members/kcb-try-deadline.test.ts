import { expect, test } from 'bun:test';
import { runKcbTryWithinDeadline } from './kcb-try-deadline.js';

test('KCB try returns at deadline and aborts a provider that ignores the signal', async () => {
  let aborted = false;
  await expect(runKcbTryWithinDeadline(signal => {
    signal.addEventListener('abort', () => { aborted = true; });
    return new Promise<string>(() => {});
  }, 10)).rejects.toThrow('try-timeout');
  expect(aborted).toBe(true);
});
