import { expect, test } from 'bun:test';
import { SeatRuntimeRegistry, type RuntimeProcess } from './seat-runtime.js';

test('runtime authority requires both the registration token and the live ancestry generation', () => {
  const runtime: RuntimeProcess = { pid: 200, ppid: 1, uid: 501, start: '200:1', name: 'codex' };
  const registrar: RuntimeProcess = { pid: 400, ppid: 200, uid: 501, start: '400:1', name: 'els' };
  const child: RuntimeProcess = { pid: 500, ppid: 200, uid: 501, start: '500:1', name: 'bun' };
  const processes = new Map([runtime, registrar, child].map(p => [p.pid, p]));
  const registry = new SeatRuntimeRegistry(pid => processes.get(pid));
  expect(registry.register(400, 501, registrar, { pid: 200, start: '200:1' })).toBe(true);
  const token = registry.registrationToken();
  expect(token).toBeTruthy();
  expect(registry.matches(500, 501, child, undefined)).toBe(false);
  expect(registry.matches(500, 501, child, 'wrong')).toBe(false);
  expect(registry.matches(500, 501, child, token)).toBe(true);
  const generation = registry.key();
  expect(registry.isLiveGeneration(generation)).toBe(true);
  expect(registry.register(400, 501, registrar, { pid: 200, start: '200:1' })).toBe(true);
  expect(registry.isLiveGeneration(generation)).toBe(false);
  expect(registry.matches(500, 501, child, token)).toBe(false);
  const next = registry.key();
  expect(next).not.toBe(generation);
  processes.set(200, { ...runtime, start: '200:2' });
  expect(registry.isLiveGeneration(next)).toBe(false);
});
