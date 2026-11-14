import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPluginManifestFromDir } from '../core/manifest.js';
import { defaultPluginStatuses, DEFAULT_PLUGIN_GROUP, DEMO1114_PLUGIN_IDS, installDefaultPluginGroup, installDemo1114PluginGroup, listInstalledPlugins } from './plugin-install.js';

const roots: string[] = [];
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'elanous-default-plugin-group-'));
  roots.push(root);
  return root;
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('default plugin group', () => {
  test('installs the curated packages into an empty config and individual keys change readiness', async () => {
    const expectedIds: Array<(typeof DEFAULT_PLUGIN_GROUP)[number]['id']> = [
      'firecrawl',
      'demo-research',
      'demo-linear-secretary',
      'demo-absorption-briefing',
      'demo-browser-hand',
      'demo-video-briefing',
      'demo-plugin-wizard',
    ];
    expect(DEFAULT_PLUGIN_GROUP.map(plugin => plugin.id)).toEqual(expectedIds);

    const installed = await installDefaultPluginGroup({ root: fixture(), yes: true });
    expect(installed.map(plugin => plugin.name)).toEqual(expectedIds);
    for (const plugin of installed) {
      expect(existsSync(join(plugin.path, 'skills', plugin.name, 'SKILL.md'))).toBe(true);
      const manifest = loadPluginManifestFromDir(plugin.path, { id: plugin.name }).manifest;
      const declaredKeys = (manifest.contributes.connectors ?? []).map(connector => connector.id).sort();
      const groupEntry = DEFAULT_PLUGIN_GROUP.find(entry => entry.id === plugin.name)!;
      expect(declaredKeys).toEqual([...groupEntry.requiredServiceKeys, ...groupEntry.optionalServiceKeys].sort());
    }

    const empty = defaultPluginStatuses();
    expect(empty.map(plugin => plugin.id)).toEqual(expectedIds);
    expect(empty.every(plugin => plugin.status === 'key-needed')).toBe(true);

    const baseline = defaultPluginStatuses({ satisfiedPrerequisites: ['llm-provider', 'aside'] });
    expect(baseline.filter(plugin => plugin.status === 'key-needed').map(plugin => plugin.id))
      .toEqual(['firecrawl', 'demo-linear-secretary']);
    const afterLinearKey = defaultPluginStatuses({
      readyServiceKeyIds: ['linear'],
      satisfiedPrerequisites: ['llm-provider', 'aside'],
    });
    expect(afterLinearKey.filter((plugin, index) => plugin.status !== baseline[index]?.status).map(plugin => plugin.id))
      .toEqual(['demo-linear-secretary']);
  });
});

test('11-14 first-run group installs every scene package into an empty state root and reruns idempotently', async () => {
  const root = fixture();
  let runtimeCalls = 0;
  const first = await installDemo1114PluginGroup({ root, runRuntimeCommand: () => {
    runtimeCalls += 1;
    return { status: 1 };
  } });
  expect(first.failed).toEqual([]);
  expect(runtimeCalls).toBe(0);
  expect(first.installed.map(item => item.name)).toEqual([...DEMO1114_PLUGIN_IDS]);
  const appDeploy = first.installed.find(item => item.name === 'elanous-app-deploy')!;
  const appDeployManifest = loadPluginManifestFromDir(appDeploy.path, { id: appDeploy.name }).manifest;
  expect(appDeployManifest.main).toBe('./plugin.ts');
  expect(appDeployManifest.activationEvents).toContain('onRoute');
  expect(existsSync(join(appDeploy.path, 'plugin.ts'))).toBe(true);
  expect(listInstalledPlugins(root).map(item => item.name).sort()).toEqual([...DEMO1114_PLUGIN_IDS].sort());

  const second = await installDemo1114PluginGroup({ root });
  expect(second.failed).toEqual([]);
  expect(second.installed.map(item => item.path)).toEqual(first.installed.map(item => item.path));
  expect(listInstalledPlugins(root)).toHaveLength(DEMO1114_PLUGIN_IDS.length);

  rmSync(join(appDeploy.path, 'plugin.ts'));
  const repaired = await installDemo1114PluginGroup({ root });
  expect(repaired.failed).toEqual([]);
  expect(existsSync(join(appDeploy.path, 'plugin.ts'))).toBe(true);

  const damaged = first.installed.find(item => item.name === 'demo-brief-to-requirements')!;
  rmSync(join(damaged.path, 'README.md'));
  const retry = await installDemo1114PluginGroup({ root });
  expect(retry.failed).toContain('demo-brief-to-requirements');
});
