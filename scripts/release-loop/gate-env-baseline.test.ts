// GATE-ENV-BASELINE (W5 · 10-15) — the gate shard Pod shell declares its deterministic env before anything runs,
// and the test runner (`test:deterministic`) passes that env through to the test processes.
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { GATE_POD_ENV_BASELINE, gateEnvBaselineLine, gateShardShell } from './gate-node';
import { gateTestBaseline } from '../lib/gate-test-env';
import { prepareIsolatedTestEnv } from '../test-deterministic';

const base = { parts: [['src/a.test.ts']], cdpPatterns: [], softSeconds: 100, cachePrefix: '', installSlots: 4 };

test('the baseline pins TZ, locale and the fake LLM switch — and carries no provider key', () => {
  expect(GATE_POD_ENV_BASELINE).toEqual({ TZ: 'UTC', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', ELANOUS_TEST_FAKE_LLM: '1' });
  expect(Object.keys(GATE_POD_ENV_BASELINE).filter((key) => /KEY|TOKEN|SECRET/.test(key))).toEqual([]);
});

test('the shard shell exports the baseline before the part runs, with or without the beat', () => {
  for (const shell of [gateShardShell(base), gateShardShell({ ...base, beatSeconds: 30 })]) {
    const lines = shell.split('\n');
    const at = lines.indexOf(gateEnvBaselineLine());
    expect(at).toBeGreaterThanOrEqual(0);
    expect(at).toBeLessThan(lines.findIndex((line) => line.includes('scripts/test-deterministic.ts') || line.includes('test:deterministic')));
  }
});

test('a pinned rules base reaches an isolated Pod test process without inventing origin/main', () => {
  const sha = 'a'.repeat(40);
  const shell = gateShardShell({ ...base, parts: [['test/rules-contract.test.ts']], parallelParts: 1, rulesBaseSha: sha });
  const lines = shell.split('\n');
  const exportLine = `export ELANOUS_GATE_BASE_SHA='${sha}'`;
  expect(lines).toContain(exportLine);
  expect(lines.indexOf(exportLine)).toBeLessThan(lines.findIndex((line) => line.includes('scripts/test-deterministic.ts')));
  const env = prepareIsolatedTestEnv({ ELANOUS_GATE_BASE_SHA: sha, PATH: '/bin' }, '/tmp/elanous-rules-base-pin');
  expect(env.ELANOUS_GATE_BASE_SHA).toBe(sha);
  expect(() => gateShardShell({ ...base, rulesBaseSha: 'HEAD' })).toThrow('invalid rules gate base SHA');
});

test('the exported line sets exactly those values in bash', () => {
  const ran = spawnSync('bash', ['-c', `${gateEnvBaselineLine()}; printf '%s|%s|%s|%s' "$TZ" "$LANG" "$LC_ALL" "$ELANOUS_TEST_FAKE_LLM"`], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
  expect(ran.status).toBe(0);
  expect(ran.stdout).toBe('UTC|C.UTF-8|C.UTF-8|1');
});

test('release shell preserves an explicit fake LLM off through the shared baseline', () => {
  const previous = process.env.ELANOUS_TEST_FAKE_LLM;
  try {
    process.env.ELANOUS_TEST_FAKE_LLM = '0';
    const expected = gateEnvBaselineLine(gateTestBaseline({ ELANOUS_TEST_FAKE_LLM: '0' }));
    expect(gateShardShell(base).split('\n')).toContain(expected);
    const ran = spawnSync('bash', ['-c', `${expected}; printf '%s' "$ELANOUS_TEST_FAKE_LLM"`],
      { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
    expect(ran.stdout).toBe('0');
  } finally {
    if (previous === undefined) delete process.env.ELANOUS_TEST_FAKE_LLM;
    else process.env.ELANOUS_TEST_FAKE_LLM = previous;
  }
});

test('test:deterministic keeps the baseline in the test env (it strips credentials, not these)', () => {
  const env = prepareIsolatedTestEnv({ ...GATE_POD_ENV_BASELINE, OPENAI_API_KEY: 'x', GH_TOKEN: 'y', PATH: '/bin' }, '/tmp/elanous-gate-env-baseline');
  for (const [key, value] of Object.entries(GATE_POD_ENV_BASELINE)) expect(env[key]).toBe(value);
  expect(env.OPENAI_API_KEY).toBeUndefined();
  expect(env.GH_TOKEN).toBeUndefined();
});
