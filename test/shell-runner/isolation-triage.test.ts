import { expect, test } from 'bun:test';
import { triageShellIsolation } from '../../src/shell-runner/isolation-triage.js';
import { dispatchRunShell } from '../../src/skills/tools/shell.js';

const parent = { PATH: '/bin', HOME: '/h', FAKE_API_KEY: 'fake', GH_TOKEN: 'fake', AWS_CREDENTIALS_FILE: 'fake', RANDOM_PARENT: 'fake' };

test('inline request with no isolation flags lands on the session branch', () => {
  const t = triageShellIsolation({ mode: 'inline' }, parent);
  expect(t.allowed && t.isolation).toBe('session');
});

test('bg mode lands on isolated-session', () => {
  const t = triageShellIsolation({ mode: 'bg' }, parent);
  expect(t.allowed && t.isolation).toBe('isolated-session');
});

test('strict sandbox or network off lands on inline-isolated', () => {
  expect(triageShellIsolation({ sandbox: 'strict' }, parent).isolation).toBe('inline-isolated');
  expect(triageShellIsolation({ network: 'off' }, parent).isolation).toBe('inline-isolated');
});

test('explicit known branch is honoured', () => {
  expect(triageShellIsolation({ isolation: 'isolated-session' }, parent).isolation).toBe('isolated-session');
});

test('unknown or non-string branch is denied with empty env', () => {
  for (const bad of ['host', 'ROOT', 7, null, {}]) {
    const t = triageShellIsolation({ isolation: bad }, parent);
    expect(t.allowed).toBe(false);
    expect(t.isolation).toBeNull();
    expect(Object.keys(t.env)).toEqual([]);
  }
});

test('env allowlist strips secrets and unlisted names, keeps runtime settings and safe overrides', () => {
  const t = triageShellIsolation({ env: { CUSTOM_FLAG: 'ok', FAKE_TOKEN: 'fake' } }, parent);
  expect(Object.hasOwn(t.env, 'PATH')).toBe(true);
  expect(Object.hasOwn(t.env, 'CUSTOM_FLAG')).toBe(true);
  for (const k of ['FAKE_API_KEY', 'GH_TOKEN', 'AWS_CREDENTIALS_FILE', 'RANDOM_PARENT', 'FAKE_TOKEN']) {
    expect(Object.hasOwn(t.env, k)).toBe(false);
    expect(t.strippedEnvKeys).toContain(k);
  }
});

test('decider does not mutate the parent env', () => {
  const copy = { ...parent };
  triageShellIsolation({ env: { X: '1' } }, parent);
  expect(parent).toEqual(copy);
});

test('RunShell refuses an unknown isolation branch before spawning', async () => {
  await expect(dispatchRunShell({ command: ['true'], isolation: 'host' })).rejects.toThrow('unknown isolation branch');
});
