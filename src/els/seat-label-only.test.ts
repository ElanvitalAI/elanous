import { expect, test } from 'bun:test';
import { registerSeatRuntime } from './server.js';

test('owner OP registration without a runtime is label-only and publishes no runtime credential', () => {
  let labels = 0;
  let registrations = 0;
  let publications = 0;
  const guard = { seatSet: () => { labels++; return { exitCode: 0 as const, message: 'registered' }; } };
  const registry = { register: () => { registrations++; return false; }, registrationToken: () => undefined, clear: () => {} };
  const result = registerSeatRuntime({ op: 'seat-set', seat: 'OP' }, guard, registry, undefined, undefined, undefined, () => { publications++; });
  expect(result.exitCode).toBe(0);
  expect(labels).toBe(1);
  expect(registrations).toBe(0);
  expect(publications).toBe(0);
});
