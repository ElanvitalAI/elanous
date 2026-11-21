import { expect, test } from 'bun:test';
import { PaneRegistry, AUTH_PANE_TOKEN_ENV } from './server-auth.js';

test('credential is bound to its spawned PTY generation, not a replacement pane', () => {
  const registry = new PaneRegistry();
  const env = registry.registerSpawn({ ELANOUS_ELS_PANE: 'p', ELANOUS_ELS_WS: 'w' }, '/tmp', { kind: 'op' });
  const token = env[AUTH_PANE_TOKEN_ENV]!;
  let origin: { pid: number; start: string; generation: string } | undefined = { pid: 7, start: 'start-a', generation: 'a' };
  registry.bindSpawn(token, () => origin);
  expect(registry.spawnBinding(token)).toEqual({ pid: 7, start: 'start-a', generation: 'a' });
  origin = { pid: 8, start: 'start-b', generation: 'b' };
  expect(registry.spawnBinding(token)).toBeUndefined();
  origin = undefined;
  expect(registry.spawnBinding(token)).toBeUndefined();
});

test('a pinned credential cannot revive after its PTY disappears', () => {
  const registry = new PaneRegistry();
  const env = registry.registerSpawn({ ELANOUS_ELS_PANE: 'p', ELANOUS_ELS_WS: 'w' }, '/tmp', { kind: 'op' });
  const token = env[AUTH_PANE_TOKEN_ENV]!;
  const original = { pid: 7, start: 'start-a', generation: 'a' };
  let origin: typeof original | undefined;
  registry.bindSpawn(token, () => origin);
  expect(registry.spawnBinding(token)).toBeUndefined(); // Holder has not published its first binding yet.
  origin = original;
  expect(registry.spawnBinding(token)).toEqual(original);
  origin = undefined;
  expect(registry.spawnBinding(token)).toBeUndefined();
  origin = original;
  expect(registry.spawnBinding(token)).toBeUndefined();
});
