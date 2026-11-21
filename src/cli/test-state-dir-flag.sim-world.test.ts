import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const entry = join(import.meta.dir, 'test-state-dir-flag.ts');

describe('sim world credential isolation', () => {
  it('does not copy operating auth or secrets into a fresh simulation root', () => {
    const base = mkdtempSync(join(tmpdir(), 'sim-world-no-credential-'));
    try {
      const home = join(base, 'home');
      const operating = join(home, '.elanous');
      const root = join(base, 'state');
      mkdirSync(operating, { recursive: true });
      mkdirSync(root);
      writeFileSync(join(operating, 'config.json'), '{}');
      writeFileSync(join(operating, 'auth.json'), '{"providers":{"fake":{"tokens":{"accessToken":"fake-operating-token"}}}}');
      writeFileSync(join(operating, 'secrets.json'), '{"secrets":{"fake-operating-key":"fake-operating-value"}}');
      const script = `process.argv = ['bun', 'elanous.mjs', 'sim', 'world', 'run', 'capsule-events']; const m = await import(${JSON.stringify(entry)}); m.applyIsolatedRoot(${JSON.stringify(root)});`;
      const run = spawnSync(process.execPath, ['-e', script], {
        env: { PATH: process.env.PATH ?? '', HOME: home, NODE_ENV: 'development' }, encoding: 'utf8', timeout: 15_000,
      });
      expect(run.status).toBe(0);
      expect(existsSync(join(root, 'auth.json'))).toBe(false);
      expect(existsSync(join(root, 'secrets.json'))).toBe(false);
      expect(existsSync(join(root, 'config.json'))).toBe(false);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it('refuses a simulation root that already contains credentials', () => {
    const root = mkdtempSync(join(tmpdir(), 'sim-world-stale-credential-'));
    try {
      writeFileSync(join(root, 'auth.json'), '{"tokens":{"accessToken":"fake-stale-token"}}');
      const script = `process.argv = ['bun', 'elanous.mjs', 'sim', 'world', 'run', 'capsule-events']; const m = await import(${JSON.stringify(entry)}); m.applyIsolatedRoot(${JSON.stringify(root)});`;
      const run = spawnSync(process.execPath, ['-e', script], {
        env: { PATH: process.env.PATH ?? '', HOME: join(root, 'empty-home'), NODE_ENV: 'development' }, encoding: 'utf8', timeout: 15_000,
      });
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain('sim world credential');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
