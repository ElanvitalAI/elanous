import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { POD_BUN_CACHE_HOST_PATH, parseInstallSeconds, podBunCacheVolume } from './pod-bun-cache.js';

describe('pod Bun cache', () => {
  test('exports the host-path environment key and a writable DirectoryOrCreate mount', () => {
    expect(POD_BUN_CACHE_HOST_PATH).toBe('POD_BUN_CACHE_HOST_PATH');
    const cache = podBunCacheVolume('/srv/bun-cache');
    expect(cache.volume).toEqual({ name: 'bun-cache', hostPath: { path: '/srv/bun-cache', type: 'DirectoryOrCreate' } });
    expect(cache.volumeMount).toEqual({ name: 'bun-cache', mountPath: '/bun-cache', readOnly: false });
  });

  test('shell prefix exports the cache only when the mount is writable', () => {
    const { shellPrefix } = podBunCacheVolume('/srv/bun-cache');
    expect(shellPrefix).toContain('BUN_INSTALL_CACHE_DIR=/bun-cache');
    expect(shellPrefix).toContain('[ -w /bun-cache ]');
    expect(shellPrefix.endsWith(';')).toBe(true);
    const dir = mkdtempSync(join(tmpdir(), 'pod-bun-cache-'));
    try {
      const mounted = join(dir, 'bun-cache');
      const guarded = shellPrefix.replaceAll('/bun-cache', mounted);
      const writable = spawnSync('bash', ['-c', `${guarded} printf '%s' "\${BUN_INSTALL_CACHE_DIR-unset}"`], { encoding: 'utf8', env: { PATH: process.env.PATH } });
      expect(writable.status).toBe(0);
      expect(writable.stdout).toBe('unset');
      mkdirSync(mounted);
      const enabled = spawnSync('bash', ['-c', `${guarded} printf '%s' "\${BUN_INSTALL_CACHE_DIR-unset}"`], { encoding: 'utf8', env: { PATH: process.env.PATH } });
      expect(enabled.status).toBe(0);
      expect(enabled.stdout).toBe(mounted);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('parses the first install duration in seconds, including millisecond output', () => {
    expect(parseInstallSeconds('5 packages installed [750ms]\n2 packages installed [3.5s]')).toBe(0.75);
    expect(parseInstallSeconds('2 packages installed [3.5s]\nChecked 9 installs across 10 packages (no changes) [400ms]')).toBe(3.5);
    expect(parseInstallSeconds('Checked 9 installs across 10 packages (no changes) [400ms]')).toBe(0.4);
  });

  test('returns null when no Bun install timing is present', () => {
    expect(parseInstallSeconds('Ran 10 tests across 2 files\n0 fail')).toBeNull();
    expect(parseInstallSeconds('')).toBeNull();
  });
});
