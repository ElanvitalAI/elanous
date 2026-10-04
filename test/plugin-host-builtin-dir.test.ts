import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, join } from 'path';
import { BUILTIN_DIR, PluginHost, USER_DIR, type HostHooks } from '../src/plugins/core/host.js';

const tempDirs: string[] = [];

const hooks: HostHooks = {
  log: () => {},
  hudSet: () => {},
  requestRender: () => {},
  focusPane: () => {},
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('PluginHost built-in plugin directory', () => {
  test('discovers repository built-ins without activating them or scanning user plugins', async () => {
    expect(existsSync(BUILTIN_DIR)).toBe(true);

    const builtinPluginIds = readdirSync(BUILTIN_DIR).filter((name) => {
      const candidate = join(BUILTIN_DIR, name);
      if (!statSync(candidate).isDirectory() || !existsSync(join(candidate, 'plugin.ts'))) return false;
      const manifestPath = join(candidate, 'plugin.json');
      if (!existsSync(manifestPath)) return true;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      // Portable graph bundles without an explicit main are installer inputs, not host built-ins.
      return !manifest.extensions?.['ai.elanous'] || Boolean(manifest.main);
    });
    expect(builtinPluginIds.length).toBeGreaterThan(0);

    const emptyUserDir = mkdtempSync(join(tmpdir(), 'elanous-empty-user-plugins-'));
    tempDirs.push(emptyUserDir);
    const host = new PluginHost(hooks, null, { userDir: emptyUserDir });
    await host.discover();

    const discoveredBuiltinIds = host.list()
      .filter((entry) => entry.source === 'builtin')
      .map((entry) => entry.manifest.id);
    expect(discoveredBuiltinIds).toEqual(expect.arrayContaining(builtinPluginIds));
    expect(host.active()).toBeNull();
    expect(basename(USER_DIR)).toBe('plugins');
    expect(basename(dirname(USER_DIR))).toBe('.claude');
  });
});
