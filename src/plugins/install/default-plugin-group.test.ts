import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPluginManifestFromDir } from '../core/manifest.js';
import { defaultPluginStatuses, DEFAULT_PLUGIN_GROUP, installDefaultPluginGroup } from './plugin-install.js';

const roots: string[] = [];
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'elanous-default-plugin-group-'));
  roots.push(root);
  return root;
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('default plugin group', () => {
  test('installs the six curated packages into an empty config and only Linear key changes readiness', async () => {
    const expectedIds = [
      'demo-research',
      'demo-linear-secretary',
      'demo-absorption-briefing',
      'demo-browser-hand',
      'demo-video-briefing',
      'demo-plugin-wizard',
    ];
    expect(DEFAULT_PLUGIN_GROUP.map(plugin => plugin.id)).toEqual(expectedIds);

    const installed = await installDefaultPluginGroup({ root: fixture() });
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
      .toEqual(['demo-linear-secretary']);
    const afterLinearKey = defaultPluginStatuses({
      readyServiceKeyIds: ['linear'],
      satisfiedPrerequisites: ['llm-provider', 'aside'],
    });
    expect(afterLinearKey.filter((plugin, index) => plugin.status !== baseline[index]?.status).map(plugin => plugin.id))
      .toEqual(['demo-linear-secretary']);
  });
});
