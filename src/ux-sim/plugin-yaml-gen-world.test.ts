import { expect, test } from 'bun:test';
import { simulatePluginYamlGen } from './plugin-yaml-gen-world.js';

test('plugin.yaml generates a committed manifest that installs and reloads a code-free absorb graph', async () => {
  const observation = await simulatePluginYamlGen();
  expect(observation.installed).toBe(true);
  expect(observation.generatedManifestMatches).toBe(true);
  expect(observation.graphIds).toEqual(['absorb-brief']);
  expect(observation.capabilities).toEqual(['store', 'extract', 'llm-judge']);
});
