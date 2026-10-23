import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('selected full-CLI commands keep their help and read-only actions without dashboard imports', () => {
  const root = resolve(import.meta.dir, '../..');
  const dir = mkdtempSync(join(tmpdir(), 'index-lazy-'));
  const preload = join(dir, 'block-dashboard.ts');
  writeFileSync(preload, `Bun.plugin({ setup(build) {
    build.onLoad({ filter: /[\\/]src[\\/]dashboard[\\/].*\\.ts$/ }, (a) => {
      throw new Error('DASHBOARD_EAGERLY_LOADED: ' + a.path);
    });
  } });`);
  try {
    for (const args of [
      ['provider', '--help'],
      ['docs', '--help'],
      ['docs', 'search', '--help'],
      ['doctor', '--help'],
      ['--test=' + join(dir, 'test-state'), 'provider', '--help'],
    ]) {
      const child = spawnSync(process.execPath, ['--preload', preload, 'bin/elanous.mjs', ...args], {
        cwd: root, encoding: 'utf8', timeout: 30_000,
        env: { ...process.env, ELANOUS_CONFIG_DIR: join(dir, 'ignored-env-config') },
      });
      expect(child.status, `${args.join(' ')} stderr:\n${child.stderr}`).toBe(0);
      expect(child.stderr).not.toContain('DASHBOARD_EAGERLY_LOADED');
      expect(child.stdout).toContain('Usage:');
    }
    const action = spawnSync(process.execPath, [
      '--preload', preload, 'bin/elanous.mjs', '--test=' + join(dir, 'test-state'), 'where', '--json',
    ], {
      cwd: root, encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, ELANOUS_CONFIG_DIR: join(dir, 'ignored-env-config') },
    });
    expect(action.status).toBe(0);
    expect(action.stderr).not.toContain('DASHBOARD_EAGERLY_LOADED');
    const where = JSON.parse(action.stdout);
    expect(JSON.stringify(where)).toContain(join(dir, 'test-state'));
    const provider = spawnSync(process.execPath, [
      '--preload', preload, 'bin/elanous.mjs', '--test=' + join(dir, 'test-state'), 'provider',
    ], {
      cwd: root, encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, ELANOUS_CONFIG_DIR: join(dir, 'ignored-env-config') },
    });
    expect(provider.status).toBe(0);
    expect(provider.stdout).toContain('Active LLM provider');
    expect(provider.stderr).not.toContain('DASHBOARD_EAGERLY_LOADED');
    const unknownFlag = spawnSync(process.execPath, [
      '--preload', preload, 'bin/elanous.mjs', 'provider', '--unknown-global',
    ], {
      cwd: root, encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, ELANOUS_CONFIG_DIR: join(dir, 'ignored-env-config') },
    });
    expect(unknownFlag.status).not.toBe(0);
    expect(unknownFlag.stderr).toContain('DASHBOARD_EAGERLY_LOADED');
    const fullHelp = spawnSync(process.execPath, ['bin/elanous.mjs', '--help'], {
      cwd: root, encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, ELANOUS_CONFIG_DIR: join(dir, 'ignored-env-config') },
    });
    expect(fullHelp.status).toBe(0);
    expect(fullHelp.stdout).toContain('Usage:');
    expect(fullHelp.stderr).not.toContain('require() async module');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);
