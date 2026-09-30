import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installPlugin, removePlugin } from '../plugins/install/plugin-install.js';
import { createNexusState } from '../nexus/state/state.js';
import { TabRegistry } from '../nexus/state/tab-registry.js';
import { NexusEventBus } from '../nexus/api/event-bus.js';
import { createDevProxyRuntimeRef } from '../nexus/api/admin-dev-proxy.js';
import { routeRequest } from '../nexus/api/http-server.js';
import { getNodeKind, getNodeKindRegistration, registerNodeKind, unregisterPluginNodeKind } from './registry.js';
import { syncInstalledPluginNodes } from './installed-plugin-nodes.js';

const roots: string[] = [];
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'elanous-installed-nodes-'));
  roots.push(root);
  return root;
}
function packageAt(root: string, name: string, node: string): string {
  const dir = join(root, `source-${name}`);
  mkdirSync(join(dir, 'nodes'), { recursive: true });
  writeFileSync(join(dir, 'plugin.ts'), 'export default {}');
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ id: name, version: '0.1.0', main: './plugin.ts', contributes: { nodes: ['./nodes/action.yaml'] } }));
  writeFileSync(join(dir, 'nodes', 'action.yaml'), node);
  return dir;
}
const valid = 'kind: action\ngraph: workflow\ninputs:\n  type: object\nrun:\n  bash: echo ok\n';

function cleanup(root: string): void {
  for (const name of ['good-plugin', 'bad-plugin', 'sync-plugin', 'owned-plugin']) {
    removePlugin(name, root);
  }
  syncInstalledPluginNodes(root);
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    cleanup(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test('installed nodes register once, skip unchanged ledger and disappear on removal', async () => {
  const root = fixture();
  await installPlugin(packageAt(root, 'sync-plugin', valid), { root });
  expect(syncInstalledPluginNodes(root)).toEqual({ registered: 1, removed: 0, errors: [] });
  expect(getNodeKind('workflow', 'sync-plugin:action')).toMatchObject({ plugin: 'sync-plugin', run: { bash: 'echo ok' } });
  const registration = getNodeKindRegistration('workflow', 'sync-plugin:action');
  expect(syncInstalledPluginNodes(root)).toEqual({ registered: 0, removed: 0, errors: [] });
  expect(getNodeKindRegistration('workflow', 'sync-plugin:action')).toBe(registration);
  expect(removePlugin('sync-plugin', root)).toBe(1);
  expect(syncInstalledPluginNodes(root)).toEqual({ registered: 0, removed: 1, errors: [] });
  expect(getNodeKind('workflow', 'sync-plugin:action')).toBeUndefined();
  expect(getNodeKind('workflow', 'bash')?.core).toBe(true);
});

test('Nexus kinds GET reconciles a same-path reinstall without an intervening removal GET', async () => {
  const root = fixture();
  const bus = new NexusEventBus();
  const state = createNexusState({ nexusVersion: 'test', phase: 'test' });
  state.bus = bus;
  const opts = { state, registry: new TabRegistry(state), eventBus: bus, pluginStateRoot: root, metaApi: { bearerToken: 'owner-secret', noAuth: false } };
  const request = async () => {
    const response = await routeRequest(new Request('http://localhost/v1/graph/kinds?graph=workflow', {
      headers: { authorization: 'Bearer owner-secret', 'sec-fetch-site': 'cross-site' },
    }), opts, { requestIP: () => ({ address: '203.0.113.1' }) } as never, null, createDevProxyRuntimeRef());
    expect(response?.status).toBe(200);
    return (await response!.json() as { kinds: Array<{ kind: string; plugin?: string }> }).kinds;
  };
  const first = await installPlugin(packageAt(root, 'sync-plugin', valid), { root });
  const ledger = join(root, 'plugins', 'installed.json');
  const stableTime = new Date('2024-01-01T00:00:00.000Z');
  utimesSync(ledger, stableTime, stableTime);
  expect((await request()).map(row => row.kind)).toContain('sync-plugin:action');
  const before = statSync(ledger);
  expect(removePlugin('sync-plugin', root)).toBe(1);
  const replacement = await installPlugin(packageAt(root, 'sync-plugin', valid.replace('kind: action', 'kind: revised')), { root });
  expect(replacement.path).toBe(first.path);
  expect(statSync(ledger).size).toBe(before.size);
  utimesSync(ledger, before.atime, before.mtime);
  expect(statSync(ledger).mtimeMs).toBe(before.mtimeMs);
  const kinds = await request();
  expect(kinds.some(row => row.kind === 'sync-plugin:action')).toBe(false);
  expect(kinds).toContainEqual(expect.objectContaining({ kind: 'sync-plugin:revised', plugin: 'sync-plugin' }));
  expect(getNodeKind('workflow', 'sync-plugin:revised')?.run).toEqual({ bash: 'echo ok' });
});

test('one broken installed declaration reports its plugin without hiding a healthy peer', async () => {
  const root = fixture();
  await installPlugin(packageAt(root, 'bad-plugin', 'kind: [broken\n'), { root });
  await installPlugin(packageAt(root, 'good-plugin', valid), { root });
  const result = syncInstalledPluginNodes(root);
  expect(result.registered).toBe(1);
  expect(result.errors).toHaveLength(1);
  expect(result.errors[0]).toMatchObject({ plugin: 'bad-plugin', reason: expect.stringContaining('action.yaml') });
  expect(getNodeKind('workflow', 'good-plugin:action')?.plugin).toBe('good-plugin');
});

test('broken sibling declaration rolls back its plugin without affecting other plugins', async () => {
  const root = fixture();
  const bad = packageAt(root, 'bad-plugin', valid);
  writeFileSync(join(bad, 'plugin.json'), JSON.stringify({ id: 'bad-plugin', version: '0.1.0', main: './plugin.ts', contributes: { nodes: ['./nodes/action.yaml', './nodes/broken.yaml'] } }));
  writeFileSync(join(bad, 'nodes', 'broken.yaml'), 'kind: [broken\n');
  await installPlugin(bad, { root });
  await installPlugin(packageAt(root, 'good-plugin', valid), { root });
  const result = syncInstalledPluginNodes(root);
  expect(result).toMatchObject({ registered: 1, removed: 0, errors: [{ plugin: 'bad-plugin' }] });
  expect(getNodeKind('workflow', 'bad-plugin:action')).toBeUndefined();
  expect(getNodeKind('workflow', 'good-plugin:action')?.plugin).toBe('good-plugin');
});

test('sync keeps a registration replaced by a different owner when an installed plugin is removed', async () => {
  const root = fixture();
  await installPlugin(packageAt(root, 'sync-plugin', valid), { root });
  expect(syncInstalledPluginNodes(root).registered).toBe(1);
  const old = getNodeKindRegistration('workflow', 'sync-plugin:action')!;
  expect(unregisterPluginNodeKind('workflow', 'sync-plugin:action', 'sync-plugin', old)).toBe(true);
  const replacement = { graph: 'workflow' as const, kind: 'sync-plugin:action', plugin: 'sync-plugin', core: false, description: 'other host' };
  expect(registerNodeKind(replacement)).toEqual({ ok: true });
  const newEntry = getNodeKindRegistration('workflow', 'sync-plugin:action')!;
  try {
    removePlugin('sync-plugin', root);
    expect(syncInstalledPluginNodes(root).removed).toBe(0);
    expect(getNodeKindRegistration('workflow', 'sync-plugin:action')).toBe(newEntry);
  } finally {
    unregisterPluginNodeKind('workflow', 'sync-plugin:action', 'sync-plugin', newEntry);
  }
});

test('sync never removes a registration owned by another host', async () => {
  const root = fixture();
  const entry = { graph: 'workflow' as const, kind: 'owned-plugin:action', plugin: 'owned-plugin', core: false, description: 'host registration' };
  expect(registerNodeKind(entry)).toEqual({ ok: true });
  const registration = getNodeKindRegistration('workflow', entry.kind)!;
  try {
    await installPlugin(packageAt(root, 'owned-plugin', valid), { root });
    const result = syncInstalledPluginNodes(root);
    expect(result.errors).toHaveLength(1);
    removePlugin('owned-plugin', root);
    expect(syncInstalledPluginNodes(root).removed).toBe(0);
    expect(getNodeKindRegistration('workflow', entry.kind)).toBe(registration);
  } finally {
    unregisterPluginNodeKind('workflow', entry.kind, 'owned-plugin', registration);
  }
});

test('authenticated Nexus kinds route sees a CLI install on next GET with no MCP servers', async () => {
  const root = fixture();
  const bus = new NexusEventBus();
  const state = createNexusState({ nexusVersion: 'test', phase: 'test' });
  state.bus = bus;
  const opts = { state, registry: new TabRegistry(state), eventBus: bus, pluginStateRoot: root, metaApi: { bearerToken: 'owner-secret', noAuth: false } };
  const request = () => routeRequest(new Request('http://localhost/v1/graph/kinds?graph=workflow', {
    headers: { authorization: 'Bearer owner-secret', 'sec-fetch-site': 'cross-site' },
  }), opts, { requestIP: () => ({ address: '203.0.113.1' }) } as never, null, createDevProxyRuntimeRef());
  const before = await request();
  expect(before?.status).toBe(200);
  expect((await before!.json() as { kinds: Array<{ kind: string }> }).kinds.some(row => row.kind === 'sync-plugin:action')).toBe(false);
  await installPlugin(packageAt(root, 'sync-plugin', valid), { root });
  const after = await request();
  expect(after?.status).toBe(200);
  expect((await after!.json() as { kinds: Array<{ kind: string; plugin?: string }> }).kinds)
    .toContainEqual(expect.objectContaining({ kind: 'sync-plugin:action', plugin: 'sync-plugin' }));
  removePlugin('sync-plugin', root);
  const removed = await request();
  expect((await removed!.json() as { kinds: Array<{ kind: string }> }).kinds.some(row => row.kind === 'sync-plugin:action')).toBe(false);
});
