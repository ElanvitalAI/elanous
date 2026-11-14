import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { defaultCapabilityRegistryForGraph } from './plugin-graph-providers.js';
import { emptyGraphCapabilityRegistry } from './capabilities.js';
import { createDashboardGraphRouteDispatcher, dispatchVerifiedDashboardGraph } from '../dashboard/plugin-route-adapter.js';

const dirs: string[] = [];
const originalState = process.env.ELANOUS_STATE_DIR;
afterEach(() => {
  if (originalState === undefined) delete process.env.ELANOUS_STATE_DIR;
  else process.env.ELANOUS_STATE_DIR = originalState;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const owner = { surface: 'tui' as const, verifiedOwner: { id: 'member-registry-fixture' } };
const modulePath = 'src/graph-runner/capability-providers/absorb-member-registry.ts';

function fixture(approval = false) {
  const root = mkdtempSync(join(tmpdir(), 'tui-declared-registry-'));
  dirs.push(root);
  process.env.ELANOUS_STATE_DIR = join(root, 'state');
  const plugin = join(root, 'plugin');
  mkdirSync(join(plugin, 'graph'), { recursive: true });
  const graph = join(plugin, 'graph', 'read.yaml');
  let source = readFileSync(resolve(import.meta.dir, '../../plugins/absorb/graph/absorb-suggest-list.yaml'), 'utf8');
  if (approval) source = source.replace('entry: list', 'entry: approval')
    .replace('nodes:\n', 'nodes:\n  - id: approval\n    type: hitl\n    hitl: { options: [{ key: y, exit: approved }, { key: N, exit: rejected, default: true }] }\n')
    .replace('edges:\n', 'edges:\n  - { from: approval, on: outcome, map: { approved: list, rejected: failed } }\n');
  writeFileSync(graph, source);
  writeFileSync(join(plugin, 'plugin.json'), JSON.stringify({
    extensions: { 'ai.elanous': { graphs: ['graph/read.yaml'], graphProviders: {
      'graph/read.yaml': { module: modulePath, factory: 'createAbsorbReadMemberRegistry' },
    } } },
  }));
  return { root, plugin, graph };
}

test('TUI verified dispatch loads the manifest production store provider instead of unprovided', async () => {
  const box = fixture();
  const result = await dispatchVerifiedDashboardGraph(box.graph, {}, owner, { deps: { root: join(box.root, 'runs') } });
  expect(result.status).toBe('done');
  expect(result.path).toEqual(['list', 'done']);
  const explicit = await dispatchVerifiedDashboardGraph(box.graph, {}, owner, {
    deps: { root: join(box.root, 'explicit-runs'), capabilityProviders: emptyGraphCapabilityRegistry() },
  });
  expect(explicit.status).toBe('failed');
  expect(explicit.nodes.some(node => node.error === 'unprovided')).toBe(true);
});

test('a verified TUI approval resume retains the declared production registry', async () => {
  const box = fixture(true);
  let approvals = 0;
  const dispatch = createDashboardGraphRouteDispatcher({ deps: { root: join(box.root, 'runs') } }, async () => {
    approvals += 1;
    return true;
  });
  const result = await dispatch('fixture', 'absorb-suggest-list', box.graph, {}, owner);
  expect(result.status).toBe('done');
  expect(result.path).toEqual(['approval', 'list', 'done']);
  expect(approvals).toBe(1);
});

test('missing owner is rejected before touching a missing graph or loading a provider', async () => {
  const box = fixture();
  await expect(dispatchVerifiedDashboardGraph(join(box.root, 'missing.yaml'), {}, undefined,
    { deps: { root: join(box.root, 'runs') } })).rejects.toMatchObject({ code: 'VERIFIED_OWNER_REQUIRED' });
  expect(existsSync(join(box.root, 'runs'))).toBe(false);
});

test('declared build factory receives the graph root and module confinement remains enforced', async () => {
  const box = fixture();
  const graphRoot = join(box.root, 'graph-root');
  writeFileSync(join(box.plugin, 'plugin.json'), JSON.stringify({
    extensions: { 'ai.elanous': { graphs: ['graph/read.yaml'], graphProviders: {
      'graph/read.yaml': { module: modulePath, factory: 'createAbsorbBuildGraphRootRegistry', withGraphRoot: true },
    } } },
  }));
  const registry = await defaultCapabilityRegistryForGraph(box.graph, graphRoot);
  expect(registry.contracts['app.publish@1']).toBeDefined();
  expect(registry.contracts['app-publish.source@1']).toBeDefined();
  expect(existsSync(join(graphRoot, 'nexus', 'member-events'))).toBe(true);
  writeFileSync(join(box.plugin, 'plugin.json'), JSON.stringify({
    extensions: { 'ai.elanous': { graphs: ['graph/read.yaml'], graphProviders: {
      'graph/read.yaml': { module: 'src/nexus/paths.ts', factory: 'nexusRootDir' },
    } } },
  }));
  await expect(defaultCapabilityRegistryForGraph(box.graph, graphRoot)).rejects.toThrow('shared graph runner');
});
