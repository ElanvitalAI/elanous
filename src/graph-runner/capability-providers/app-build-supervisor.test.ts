import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultCapabilityRegistryForGraph, withS2SupervisorProvider } from '../plugin-graph-providers.js';
import { emptyGraphCapabilityRegistry } from '../capabilities.js';
import { APP_BUILD_SUPERVISOR_CONTRACT } from './app-build-supervisor.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('declared S2 product registry gains the supervisor contract; other graph routes do not', async () => {
  const plugin = mkdtempSync(join(tmpdir(), 's2-manifest-'));
  roots.push(plugin);
  mkdirSync(join(plugin, 'graph'));
  const graph = join(plugin, 'graph', 'app-build-s2.yaml');
  writeFileSync(graph, 'graph: { id: app-build-s2 }\n');
  writeFileSync(join(plugin, 'plugin.json'), JSON.stringify({
    id: 'elanous-app-build',
    extensions: { 'ai.elanous': {
      graphs: ['./graph/app-build-s2.yaml'],
      graphProviders: { './graph/app-build-s2.yaml': {
        module: 'src/graph-runner/capability-providers/source-build.ts',
        factory: 'createSourceBuildRegistry',
      } },
    } },
  }));
  const registry = await defaultCapabilityRegistryForGraph(graph);
  expect(registry.contracts[APP_BUILD_SUPERVISOR_CONTRACT]).toBeDefined();
  expect(registry.providers.some(provider => provider.id === 'app-build-supervisor-correct')).toBe(true);
  expect(withS2SupervisorProvider('elanous-app-build', 'graph/app-build.yaml', emptyGraphCapabilityRegistry())
    .contracts[APP_BUILD_SUPERVISOR_CONTRACT])
    .toBeUndefined();
});
