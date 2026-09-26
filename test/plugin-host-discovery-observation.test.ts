import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { dashboardMatches, dashboardSourceLocations, readDashboardSources } from './helpers/dashboard-source.js';
import { tmpdir } from 'os';
import { join } from 'path';
import { debug } from '../src/debug/log.js';
import { PluginHost, type HostHooks } from '../src/plugins/core/host.js';

const tempDirs: string[] = [];

const hooks: HostHooks = {
  log: () => {},
  hudSet: () => {},
  requestRender: () => {},
  focusPane: () => {},
};

function createDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writePlugin(dir: string, name: string, body: string): void {
  const pluginDir = join(dir, name);
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, 'plugin.ts'), body);
}

function discoveryEvents() {
  return debug.events(100).filter(({ category }) => category === 'plugin.discovery');
}

beforeEach(() => {
  debug.enable();
  debug.clear();
});

afterEach(() => {
  debug.disable();
  debug.clear();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('PluginHost discovery observation', () => {
  test('is wired through dashboard bootstrap PluginHost.discover()', () => {
    const sources = readDashboardSources();
    const matches = dashboardMatches(/pluginHost\s*=\s*new PluginHost\([\s\S]*?await pluginHost\.discover\(\)/, sources);
    expect(matches.length, `PluginHost discovery not wired in ${dashboardSourceLocations(sources)}`).toBeGreaterThan(0);
  });

  test('records existing empty and missing directories with distinct existence states', async () => {
    const existing = createDir('elanous-plugin-existing-');
    const missing = join(existing, 'missing');
    const host = new PluginHost(hooks, null, { userDir: existing });

    await (host as any).scanDir(existing, 'user');
    await (host as any).scanDir(missing, 'user');

    expect(discoveryEvents()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: 'scan',
        data: expect.objectContaining({ dir: existing, source: 'user', exists: true, count: 0 }),
      }),
      expect.objectContaining({
        event: 'scan',
        data: expect.objectContaining({ dir: missing, source: 'user', exists: false, count: 0 }),
      }),
    ]));
  });

  test('records empty and two-plugin scan totals and the discovery completion total', async () => {
    const empty = createDir('elanous-plugin-empty-');
    const plugins = createDir('elanous-plugin-two-');
    writePlugin(plugins, 'first', `export default { name: 'first', version: '1', description: '', initialState: () => ({}), panes: {} };`);
    writePlugin(plugins, 'second', `export default { name: 'second', version: '1', description: '', initialState: () => ({}), panes: {} };`);
    const host = new PluginHost(hooks, null, { userDir: empty });

    await (host as any).scanDir(empty, 'user');
    await (host as any).scanDir(plugins, 'user');
    await host.discover();

    const events = discoveryEvents();
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: 'scan',
        data: expect.objectContaining({ dir: empty, source: 'user', exists: true, count: 0 }),
      }),
      expect.objectContaining({
        event: 'scan',
        data: expect.objectContaining({ dir: plugins, source: 'user', exists: true, count: 2 }),
      }),
      expect.objectContaining({
        event: 'complete',
        data: expect.objectContaining({ count: host.list().length }),
      }),
    ]));
  });

  test('records failed plugin identity and reason without discovering it', async () => {
    const plugins = createDir('elanous-plugin-failed-');
    writePlugin(plugins, 'broken-plugin', 'export const plugin = null;');
    const host = new PluginHost(hooks, null, { userDir: plugins });

    await (host as any).scanDir(plugins, 'user');

    expect(host.list()).toHaveLength(0);
    expect(discoveryEvents()).toContainEqual(expect.objectContaining({
      event: 'error',
      data: expect.objectContaining({ plugin: 'broken-plugin', reason: 'no default export' }),
    }));
  });
});
