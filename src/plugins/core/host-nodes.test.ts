import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getNodeKind, getNodeKindRegistration, registerNodeKind, unregisterPluginNodeKind } from '../../graph-kinds/registry.js';
import { PACKS_DIR, PluginHost, type HostHooks } from './host.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function writePlugin(root: string, id: string, node: string): void {
  const dir = join(root, id);
  mkdirSync(join(dir, 'nodes'), { recursive: true });
  writeFileSync(join(dir, 'plugin.ts'), `export default { name: '${id}', version: '1', initialState: () => ({}), panes: {} };`);
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ id, contributes: { nodes: ['./nodes/action.yaml'] } }));
  writeFileSync(join(dir, 'nodes', 'action.yaml'), node);
}

test('discovery loads every plugin node without losing built-ins, packs, or later plugins after a bad node', async () => {
  const root = mkdtempSync(join(tmpdir(), 'elanous-host-nodes-'));
  dirs.push(root);
  const valid = (kind: string) => `kind: ${kind}\ngraph: workflow\ninputs:\n  type: object\n  properties:\n    text:\n      type: string\nrun:\n  bash: 'printf %s {{inputs.text}}'\n`;
  writePlugin(root, 'discovery-node-first', valid('first'));
  writePlugin(root, 'discovery-node-bad', 'kind: [invalid\n');
  writePlugin(root, 'discovery-node-last', valid('last'));
  const messages: string[] = [];
  const hooks: HostHooks = {
    log: (message) => { messages.push(message); },
    hudSet: () => {}, requestRender: () => {}, focusPane: () => {},
  };
  const packsDir = join(root, 'packs');
  const packDir = join(packsDir, 'discovery-pack');
  mkdirSync(join(packDir, 'nodes'), { recursive: true });
  writeFileSync(join(packDir, 'plugin.json'), JSON.stringify({ name: 'discovery-pack', extensions: { 'ai.elanous': { nodes: ['./nodes/action.yaml'] } } }));
  writeFileSync(join(packDir, 'nodes', 'action.yaml'), valid('packed'));
  const packBroken = join(packsDir, 'discovery-pack-bad');
  mkdirSync(join(packBroken, 'nodes'), { recursive: true });
  writeFileSync(join(packBroken, 'plugin.json'), JSON.stringify({ name: 'discovery-pack-bad', contributes: { nodes: ['./nodes/action.yaml'] } }));
  writeFileSync(join(packBroken, 'nodes', 'action.yaml'), 'kind: [invalid\n');
  const packLast = join(packsDir, 'discovery-pack-last');
  mkdirSync(join(packLast, 'nodes'), { recursive: true });
  writeFileSync(join(packLast, 'plugin.json'), JSON.stringify({ name: 'discovery-pack-last', contributes: { nodes: ['./nodes/action.yaml'] } }));
  writeFileSync(join(packLast, 'nodes', 'action.yaml'), valid('after-bad'));
  const host = new PluginHost(hooks, null, { userDir: root, packsDir });
  await host.discover();

  expect(host.list().filter((entry) => entry.source === 'user').map((entry) => entry.manifest.id).sort()).toEqual([
    'discovery-node-bad', 'discovery-node-first', 'discovery-node-last',
  ]);
  expect(host.list().some((entry) => entry.source === 'builtin')).toBe(true);
  expect(getNodeKind('workflow', 'discovery-node-first:first')?.run).toEqual({ bash: 'printf %s {{inputs.text}}' });
  expect(getNodeKind('workflow', 'discovery-node-last:last')?.run).toEqual({ bash: 'printf %s {{inputs.text}}' });
  expect(getNodeKind('workflow', 'discovery-pack:packed')?.plugin).toBe('discovery-pack');
  expect(getNodeKind('workflow', 'discovery-pack-last:after-bad')?.plugin).toBe('discovery-pack-last');
  expect(messages.some((message) => message.includes('discovery-node-bad') && message.includes('node'))).toBe(true);
  expect(messages.some((message) => message.includes('discovery-pack-bad') && message.includes('node'))).toBe(true);
  expect(PACKS_DIR).toBe(join(import.meta.dir, '..', '..', '..', 'packs'));
  expect(host.list().some((entry) => entry.manifest.id === 'discovery-pack')).toBe(false);
});

test('rediscovery replaces changed nodes, removes deleted plugin and pack nodes, and preserves core and external kinds', async () => {
  const root = mkdtempSync(join(tmpdir(), 'elanous-host-rediscovery-'));
  dirs.push(root);
  const packsDir = join(root, 'packs');
  const packDir = join(packsDir, 'rediscovery-pack');
  const node = (kind: string, command: string) => `kind: ${kind}\ngraph: workflow\ninputs:\n  type: object\nrun:\n  bash: '${command}'\n`;
  writePlugin(root, 'rediscovery-first', node('old', 'echo old'));
  writePlugin(root, 'rediscovery-deleted', node('gone', 'echo gone'));
  mkdirSync(join(packDir, 'nodes'), { recursive: true });
  writeFileSync(join(packDir, 'plugin.json'), JSON.stringify({ id: 'rediscovery-pack', contributes: { nodes: ['./nodes/action.yaml'] } }));
  writeFileSync(join(packDir, 'nodes', 'action.yaml'), node('packed', 'echo packed'));
  const harnessDir = join(root, 'rediscovery-harness');
  writePlugin(root, 'rediscovery-harness', 'kind: check\ngraph: harness\ninputs:\n  type: object\n');
  const external = 'rediscovery-external:keep';
  expect(registerNodeKind({ graph: 'workflow', kind: external, plugin: 'rediscovery-external', description: '', core: false, run: { bash: 'echo external' } })).toEqual({ ok: true });
  const hooks: HostHooks = { log: () => {}, hudSet: () => {}, requestRender: () => {}, focusPane: () => {} };
  const host = new PluginHost(hooks, null, { userDir: root, packsDir });
  await host.discover();
  expect(getNodeKind('workflow', 'rediscovery-first:old')?.run).toEqual({ bash: 'echo old' });
  expect(getNodeKind('workflow', 'rediscovery-deleted:gone')).toBeDefined();
  expect(getNodeKind('workflow', 'rediscovery-pack:packed')).toBeDefined();
  expect(getNodeKind('harness', 'rediscovery-harness:check')).toBeDefined();

  writePlugin(root, 'rediscovery-first', node('new', 'echo new'));
  rmSync(join(root, 'rediscovery-deleted'), { recursive: true });
  rmSync(harnessDir, { recursive: true });
  rmSync(packDir, { recursive: true });
  await host.discover();
  expect(getNodeKind('workflow', 'rediscovery-first:old')).toBeUndefined();
  expect(getNodeKind('workflow', 'rediscovery-first:new')?.run).toEqual({ bash: 'echo new' });
  expect(getNodeKind('workflow', 'rediscovery-deleted:gone')).toBeUndefined();
  expect(getNodeKind('workflow', 'rediscovery-pack:packed')).toBeUndefined();
  expect(getNodeKind('harness', 'rediscovery-harness:check')).toBeUndefined();
  expect(getNodeKind('harness', 'agent')?.core).toBe(true);
  expect(getNodeKind('workflow', external)?.run).toEqual({ bash: 'echo external' });
  expect(getNodeKind('workflow', 'bash')?.core).toBe(true);

  const replacement = { graph: 'workflow' as const, kind: 'rediscovery-first:new', plugin: 'rediscovery-first', description: 'externally updated', core: false, run: { bash: 'echo external replacement' } };
  expect(registerNodeKind(replacement)).toEqual({ ok: false, reason: 'duplicate' });
  expect(unregisterPluginNodeKind('workflow', replacement.kind, replacement.plugin, getNodeKindRegistration('workflow', replacement.kind)!)).toBe(true);
  expect(registerNodeKind(replacement)).toEqual({ ok: true });
  await host.discover();
  expect(getNodeKind('workflow', replacement.kind)?.run).toEqual(replacement.run);

  expect(unregisterPluginNodeKind('workflow', replacement.kind, replacement.plugin, getNodeKindRegistration('workflow', replacement.kind)!)).toBe(true);
  writePlugin(root, 'rediscovery-first', node('new', 'echo updated'));
  await host.discover();
  expect(getNodeKind('workflow', 'rediscovery-first:new')?.run).toEqual({ bash: 'echo updated' });
});

test('rediscovery does not delete a replacement registration sharing run and schema references', async () => {
  const root = mkdtempSync(join(tmpdir(), 'elanous-host-ownership-'));
  dirs.push(root);
  const kind = 'rediscovery-owned:action';
  writePlugin(root, 'rediscovery-owned', 'kind: action\ngraph: workflow\ninputs:\n  type: object\nrun:\n  bash: echo owned\n');
  const host = new PluginHost({ log: () => {}, hudSet: () => {}, requestRender: () => {}, focusPane: () => {} }, null, {
    userDir: root, packsDir: join(root, 'absent-packs'),
  });
  await host.discover();
  const original = getNodeKindRegistration('workflow', kind)!;
  expect(unregisterPluginNodeKind('workflow', kind, 'rediscovery-owned', original)).toBe(true);
  expect(registerNodeKind({ ...original, description: 'external replacement' })).toEqual({ ok: true });
  const replacement = getNodeKindRegistration('workflow', kind)!;
  expect(replacement).not.toBe(original);
  expect(replacement.run).toBe(original.run);
  expect(replacement.schema).toBe(original.schema);
  expect(unregisterPluginNodeKind('workflow', kind, 'rediscovery-owned', original)).toBe(false);
  await host.discover();
  expect(getNodeKindRegistration('workflow', kind)).toBe(replacement);
  expect(getNodeKind('workflow', kind)?.description).toBe('external replacement');
  expect(unregisterPluginNodeKind('workflow', kind, 'rediscovery-owned', replacement)).toBe(true);
});
