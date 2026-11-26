// DEMO-FANOUT-LIVE-OP-SEAT — an eln in the OP seat pane registers its own runtime (`els seat set OP`) before acting.
import { afterEach, expect, test } from 'bun:test';
import { ensureOpRuntimeRegistered, resetOpRuntimeRegistrationForTesting } from './els-control-tool.js';

afterEach(() => resetOpRuntimeRegistrationForTesting());

const opPane = { ELANOUS_TRACK: 'OP', ELANOUS_ELS_PANE_TOKEN: 'a'.repeat(48), ELANOUS_ELS_SOCKET: '/u/els/els.sock' };

function recorder(code = 0) {
  const calls: Array<{ argv: readonly string[]; env: Record<string, string | undefined> }> = [];
  return { calls, run: async (argv: readonly string[], env: Record<string, string | undefined>) => { calls.push({ argv, env }); return { code, out: '' }; } };
}

test('the OP pane runs `side seat set OP` once, as a child carrying this runtime', async () => {
  const r = recorder();
  const deps = { env: opPane, run: r.run, runtime: () => ({ pid: 4242, start: '1795597000:123' }), entry: '/pkg/bin/elanous.mjs' };
  expect(await ensureOpRuntimeRegistered(deps)).toBe(true);
  expect(await ensureOpRuntimeRegistered(deps)).toBe(true);
  expect(r.calls.length).toBe(1);
  expect(r.calls[0]!.argv.slice(1)).toEqual(['/pkg/bin/elanous.mjs', 'side', 'seat', 'set', 'OP']);
  expect(r.calls[0]!.env.ELN_SEAT_RUNTIME).toBe('{"pid":4242,"start":"1795597000:123"}');
  expect(r.calls[0]!.env.ELANOUS_ELS_PANE_TOKEN).toBe('a'.repeat(48));
});

test('another seat, a pane without its credential, or no els socket never tries', async () => {
  const r = recorder();
  const base = { run: r.run, runtime: () => ({ pid: 1, start: '1:1' }), entry: '/e' };
  expect(await ensureOpRuntimeRegistered({ ...base, env: { ...opPane, ELANOUS_TRACK: 'TC' } })).toBe(false);
  expect(await ensureOpRuntimeRegistered({ ...base, env: { ELANOUS_TRACK: 'OP', ELANOUS_ELS_SOCKET: '/u/els/els.sock' } })).toBe(false);
  expect(await ensureOpRuntimeRegistered({ ...base, env: { ELANOUS_TRACK: 'OP', ELANOUS_ELS_PANE_TOKEN: 'b'.repeat(48) } })).toBe(false);
  expect(r.calls.length).toBe(0);
});

test('a refused registration is not remembered: the next acting call tries again', async () => {
  const refused = recorder(1);
  const deps = { env: opPane, run: refused.run, runtime: () => ({ pid: 7, start: '2:2' }), entry: '/e' };
  expect(await ensureOpRuntimeRegistered(deps)).toBe(false);
  expect(await ensureOpRuntimeRegistered(deps)).toBe(false);
  expect(refused.calls.length).toBe(2);
});

test('no runtime identity (not darwin, process gone) registers nothing', async () => {
  const r = recorder();
  expect(await ensureOpRuntimeRegistered({ env: opPane, run: r.run, runtime: () => undefined, entry: '/e' })).toBe(false);
  expect(r.calls.length).toBe(0);
});

test('ELS-OP-AUTOREG-TRACK: the server-minted OP pane without ELANOUS_TRACK still registers (seat from ELANOUS_ELS_WS)', async () => {
  const r = recorder();
  const env = { ELANOUS_ELS_WS: 'OP', ELANOUS_ELS_PANE_TOKEN: 'a'.repeat(48), ELANOUS_ELS_SOCKET: '/u/els/els.sock' };
  expect(await ensureOpRuntimeRegistered({ env, run: r.run, runtime: () => ({ pid: 7, start: '1:2' }), entry: '/e' })).toBe(true);
  expect(r.calls.length).toBe(1);
  resetOpRuntimeRegistrationForTesting();
  const other = recorder();
  expect(await ensureOpRuntimeRegistered({ env: { ...env, ELANOUS_ELS_WS: 'JUDGE' }, run: other.run, runtime: () => ({ pid: 7, start: '1:2' }), entry: '/e' })).toBe(false);
  expect(other.calls.length).toBe(0);
});
