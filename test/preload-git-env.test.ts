import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GIT_LOCATION_ENV_KEYS } from '../scripts/test-deterministic.js';

// The guarantee lives in bunfig.toml's [test].preload. The public export ships no bunfig.toml, so there is no
// preload to test there — run only where the tree declares it.
const preloadDeclared = (() => {
  const bunfig = join(import.meta.dir, '..', 'bunfig.toml');
  return existsSync(bunfig) && readFileSync(bunfig, 'utf8').includes('preload-isolation.ts');
})();

test.skipIf(!preloadDeclared)('direct bun test clears inherited Git location before a config write in another cwd', () => {
  const root = mkdtempSync(join(tmpdir(), 'elanous-preload-git-'));
  try {
    const shared = join(root, 'shared');
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(shared);
    mkdirSync(elsewhere);
    const cleanEnv = { ...process.env };
    for (const key of GIT_LOCATION_ENV_KEYS) delete cleanEnv[key];
    const init = spawnSync('git', ['init', shared], { env: cleanEnv, encoding: 'utf8' });
    expect(init.status).toBe(0);
    const sharedConfig = join(shared, '.git', 'config');
    const originalConfig = readFileSync(sharedConfig, 'utf8');
    const fixture = join(root, 'probe.test.ts');
    writeFileSync(fixture, `
import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from ${JSON.stringify(join(import.meta.dir, '../src/debug/log.ts'))};

test('inherited Git location is absent after preload', () => {
  for (const key of ${JSON.stringify(GIT_LOCATION_ENV_KEYS)}) expect(process.env[key]).toBeUndefined();
  expect(debug.events().some((event) => event.category === 'test.preload'
    && event.event === 'git-location-env-cleared'
    && ${JSON.stringify(GIT_LOCATION_ENV_KEYS)}.every((key) => (event.data as { keys: string[] }).keys.includes(key)))).toBe(true);
});

test('config write from another cwd cannot reach the inherited repository; local repo writes still work', () => {
  const elsewhere = ${JSON.stringify(elsewhere)};
  const leaked = spawnSync('git', ['config', 'user.email', 'x@y'], { cwd: elsewhere, encoding: 'utf8' });
  expect(leaked.status).not.toBe(0);
  const local = mkdtempSync(join(tmpdir(), 'elanous-preload-local-'));
  try {
    expect(spawnSync('git', ['init'], { cwd: local, encoding: 'utf8' }).status).toBe(0);
    expect(spawnSync('git', ['config', 'user.email', 'x@y'], { cwd: local, encoding: 'utf8' }).status).toBe(0);
    expect(spawnSync('git', ['config', '--file', join(local, '.git', 'config'), '--get', 'user.email'],
      { cwd: elsewhere, encoding: 'utf8' }).stdout.trim()).toBe('x@y');
  } finally { rmSync(local, { recursive: true, force: true }); }
});
`);
    const inherited = Object.fromEntries(GIT_LOCATION_ENV_KEYS.map((key) => [key, join(shared, '.git')]));
    const child = spawnSync(process.execPath, ['test', fixture], {
      cwd: join(import.meta.dir, '..'),
      env: { ...cleanEnv, ...inherited },
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(child.status, child.stderr).toBe(0);
    expect(child.stderr).toContain('2 pass');
    expect(readFileSync(sharedConfig, 'utf8')).toBe(originalConfig);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 40_000);
