import { expect, test } from 'bun:test';
import { copyFileSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import packageManifest from '../../package.json';
import { firstRunEnvironment } from './nexus-first-run.js';

test('the production CLI bundle starts without an adjacent known-issues JSON file', () => {
  const root = mkdtempSync(join(tmpdir(), 'elanous-bundle-version-'));
  const dist = join(root, 'dist');
  const repo = resolve(import.meta.dir, '../..');
  try {
    const build = Bun.spawnSync([process.execPath, 'run', 'build', '--outdir', dist], {
      // 출처: R-TST36 — allow the production build to finish on a shared gate host.
      cwd: repo, timeout: 45_000,
    });
    expect(build.exitCode, build.stderr.toString()).toBe(0);
    copyFileSync(join(repo, 'package.json'), join(root, 'package.json'));
    symlinkSync(join(repo, 'graphs'), join(root, 'graphs'), 'junction');
    const version = Bun.spawnSync([process.execPath, join(dist, 'index.js'), '--version'], {
      // 출처: R-TST36 — startup-only CLI probe; reuse the Nexus first-run version probe budget.
      cwd: root, env: { ...firstRunEnvironment(root), ELANOUS_SKIP_LOGIN_ENV: '1' }, timeout: 15_000,
    });
    expect(version.exitCode, version.stderr.toString()).toBe(0);
    expect(version.stdout.toString().trim()).toStartWith(`${packageManifest.version} `);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 65_000);
