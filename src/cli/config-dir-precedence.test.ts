import { afterAll, describe, expect, test } from 'bun:test';

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'elanous-config-priority-'));
const xdg = join(root, 'xdg');
const explicit = join(root, 'explicit');
const state = join(root, 'state');
for (const dir of [join(xdg, 'elanous'), explicit, state]) mkdirSync(dir, { recursive: true });
for (const [dir, value] of [[join(xdg, 'elanous'), 'XDG_LEGACY'], [explicit, 'EXPLICIT_FLAG'], [state, 'STATE_DIR']]) {
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ _precedenceProbe: value }));
}
afterAll(() => rmSync(root, { recursive: true, force: true }));

const entry = resolve(import.meta.dir, '../../bin/elanous.mjs');
function query(flags: string[], stateDir?: string) {
  const env = { ...process.env, XDG_CONFIG_HOME: xdg };
  delete env.ELANOUS_CONFIG_DIR;
  if (stateDir) env.ELANOUS_STATE_DIR = stateDir;
  else delete env.ELANOUS_STATE_DIR;
  const child = spawnSync(process.execPath, [entry, 'config', 'get', '_precedenceProbe', ...flags], {
    cwd: root, env, encoding: 'utf8', timeout: 15_000,
  });
  expect({ status: child.status, signal: child.signal, stderr: child.stderr }).toMatchObject({ status: 0, signal: null });
  return child;
}

describe('config path precedence with XDG legacy present', () => {
  test('explicit --config-dir wins over both XDG and state root', () => {
    for (const stateDir of [undefined, state]) {
      const child = query(['--config-dir', explicit], stateDir);
      expect(child.stdout.trim()).toBe('EXPLICIT_FLAG');
      expect(child.stderr).not.toContain('XDG_CONFIG_HOME is set');
    }
  }, 30_000);
  test('state root wins over XDG legacy without explicit flag', () => {
    for (const child of [query([], state), query(['--test-state-dir', state])]) {
      expect(child.stdout.trim()).toBe('STATE_DIR');
      expect(child.stderr).not.toContain('XDG_CONFIG_HOME is set');
    }
  }, 30_000);
  test('parent stamp ELANOUS_STATE_DIR wins even when its path equals the production default', () => {
    const script = `import { userConfigPath } from ${JSON.stringify(new URL('../user-config.ts', import.meta.url).href)};\n` +
      `import { prodInstanceRoot } from ${JSON.stringify(new URL('../instance/resolve.ts', import.meta.url).href)};\n` +
      `console.log(userConfigPath() === prodInstanceRoot() + '/config.json');\n`;
    const child = spawnSync(process.execPath, ['-e', script], {
      cwd: root, encoding: 'utf8', timeout: 15_000,
      env: { ...process.env, XDG_CONFIG_HOME: xdg, ELANOUS_STATE_DIR: join(process.env.HOME ?? '', '.elanous') },
    });
    expect(child.status).toBe(0);
    expect(child.stdout.trim()).toBe('true');
    expect(child.stderr).not.toContain('XDG_CONFIG_HOME is set');
  }, 30_000);
  test('XDG-only callers retain legacy value and warning', () => {
    const child = query([]);
    expect(child.stdout.trim()).toBe('XDG_LEGACY');
    expect(child.stderr).toContain('XDG_CONFIG_HOME is set');
  }, 30_000);
  test('CLI explicit state selection wins when it equals the inherited preload root', () => {
    // This fixture is private to this test; never write to the runner's state root.
    const sameRoot = join(root, 'same-preload-root');
    mkdirSync(sameRoot, { recursive: true });
    writeFileSync(join(sameRoot, 'config.json'), JSON.stringify({ _precedenceProbe: 'SAME_PRELOAD_ROOT' }));
    const env = { ...process.env, XDG_CONFIG_HOME: xdg, ELANOUS_STATE_DIR: sameRoot };
    delete env.ELANOUS_STATE_DIR_SOURCE;
    const child = spawnSync(process.execPath, [entry, '--test-state-dir', sameRoot, 'config', 'get', '_precedenceProbe'], {
      cwd: root, encoding: 'utf8', timeout: 15_000, env,
    });
    expect({ status: child.status, signal: child.signal }).toEqual({ status: 0, signal: null });
    expect(child.stdout.trim()).toBe('SAME_PRELOAD_ROOT');
    expect(child.stderr).not.toContain('XDG_CONFIG_HOME is set');
  }, 30_000);
  test('inherited XDG cannot shadow the current test preload state root', () => {
    // Force a fresh preload root; never let the child reuse our test state.
    const env = { ...process.env, XDG_CONFIG_HOME: xdg, ELANOUS_CONFIG_PRELOAD_PROBE: '1' };
    delete env.ELANOUS_STATE_DIR;
    const child = spawnSync(process.execPath, ['test', join(import.meta.dir, 'config-dir-precedence-preload.test.ts')], {
      cwd: resolve(import.meta.dir, '../..'), encoding: 'utf8', timeout: 30_000, env,
    });
    expect(child.status).toBe(0);
    expect(child.stderr).toContain('1 pass');
  }, 30_000);
  test('a child inheriting the same preload path treats its stamped state as explicit', () => {
    const sameRoot = join(root, 'inherited-state-root');
    mkdirSync(sameRoot, { recursive: true });
    writeFileSync(join(sameRoot, 'config.json'), JSON.stringify({ _precedenceProbe: 'STAMPED_CHILD' }));
    const env = { ...process.env, XDG_CONFIG_HOME: xdg, ELANOUS_STATE_DIR: sameRoot };
    delete env.ELANOUS_STATE_DIR_SOURCE;
    const child = spawnSync(process.execPath, [entry, 'config', 'get', '_precedenceProbe'], {
      cwd: root, encoding: 'utf8', timeout: 15_000, env,
    });
    expect({ status: child.status, signal: child.signal }).toEqual({ status: 0, signal: null });
    expect(child.stdout.trim()).toBe('STAMPED_CHILD');
    expect(child.stderr).not.toContain('XDG_CONFIG_HOME is set');
  }, 30_000);
});
