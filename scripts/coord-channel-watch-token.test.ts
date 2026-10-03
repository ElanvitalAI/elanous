// WATCH1 — a channel watcher started with a fixed GH_TOKEN goes blind when the token expires (10-03 MK, 6 hours).
// The watcher must drop fixed tokens for reads and say so; WATCH_KEEP_TOKEN=1 keeps them with a warning.
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const script = resolve(import.meta.dir, 'coord-channel-watch.sh');
const run = (env: Record<string, string | undefined>) => {
  const { GH_TOKEN: _a, GITHUB_TOKEN: _b, ...base } = process.env;
  return spawnSync('bash', [script, '--help'], { encoding: 'utf8', env: { ...base, ...env } as NodeJS.ProcessEnv, timeout: 30_000 });
};

test('a fixed GH_TOKEN is dropped for reads with a warning line', () => {
  const r = run({ GH_TOKEN: 'fixed-token-for-test' });
  expect(r.status).toBe(0);
  expect(r.stdout).toContain('[watch] GH_TOKEN/GITHUB_TOKEN 이 들어 있어 비웠다');
});

test('WATCH_KEEP_TOKEN=1 keeps the token but still warns', () => {
  const r = run({ GITHUB_TOKEN: 'fixed-token-for-test', WATCH_KEEP_TOKEN: '1' });
  expect(r.stdout).toContain('고정 토큰으로 읽는다(WATCH_KEEP_TOKEN=1)');
});

test('no token → no warning', () => {
  expect(run({}).stdout).not.toContain('[watch] GH_TOKEN');
});
