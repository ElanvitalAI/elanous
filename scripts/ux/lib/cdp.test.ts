import { expect, test } from 'bun:test';
import { portOwnedBy } from './cdp';

// #38268 REVIEW-2: the browser on the port is ours only when the PID listening there is the Chrome this run spawned.
test('ownership is by process id: our PID listening = ours; another browser on the port, nobody, or no PID = not ours', () => {
  const listening = (pids: string[]) => () => pids;
  expect(portOwnedBy(9381, 4242, listening(['4242']))).toBe(true);
  // Another Chrome already holds the port: ours failed to bind, the other one answers.
  expect(portOwnedBy(9381, 4242, listening(['777']))).toBe(false);
  expect(portOwnedBy(9381, 4242, listening([]))).toBe(false);
  expect(portOwnedBy(9381, undefined, listening(['4242']))).toBe(false);
});
