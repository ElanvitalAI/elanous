import { expect, test } from 'bun:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGraphPluginFromDir } from '../../../src/graph-runner/graph-manifest-loader.js';

const pluginDir = join(dirname(fileURLToPath(import.meta.url)), '../../../plugins/gcp-architect-expand');

test('GCP architecture plugin declares a Graph v2 route with capability and spending HITL', () => {
  const loaded = loadGraphPluginFromDir(pluginDir);
  const graph = loaded.graphs['gcp-architect-expand'];
  expect(graph).toBeDefined();
  expect(graph!.manifest.allow.capabilities).toContain('cloud-resource');
  expect(graph!.manifest.allow.recipes).toContain('cmd:*@./recipes.yaml');
  expect(graph!.manifest.hitl).toEqual(['approve']);
  expect(graph!.template.nodes.map(node => node.nodeId)).toEqual([
    'detect', 'design', 'deliverables', 'approve', 'provision', 'schedule', 'idle-stop',
    'done', 'failed',
  ]);
  expect(graph!.template.nodes.find(node => node.nodeId === 'deliverables')?.requires)
    .toBe('cloud-resource.architecture-deliverables@1');
  expect(graph!.template.nodes.find(node => node.nodeId === 'approve')?.kind).toBe('hitl');
});
