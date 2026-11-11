import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadGraphPluginFromDir } from './graph-manifest-loader.js';

const pluginDir = resolve(import.meta.dir, '../../plugins/release-win-smoke');

test('RELEASE-WIN-SMOKE declares the Windows install, version and one capture path in its plugin graph', () => {
  const plugin = loadGraphPluginFromDir(pluginDir);
  const graph = plugin.graphs['release-win-smoke'];
  expect(graph).toBeDefined();
  expect(graph?.manifest.observe?.categories).toContain('release.win-smoke');
  expect(graph?.template.nodes.filter(node => node.kind === 'subgraph').map(node => node.nodeId))
    .toEqual(['install', 'version', 'capture']);
  expect(graph?.template.edges.filter(edge => edge.on === 'outcome').map(edge => edge.map))
    .toEqual([
      { done: 'version', failed: 'failed' },
      { done: 'capture', failed: 'failed' },
      { done: 'done', failed: 'failed' },
    ]);
});

test('RELEASE-WIN-SMOKE shared skill executes only the current node ask and returns failures to the graph', () => {
  const skill = readFileSync(join(pluginDir, 'skills/install/SKILL.md'), 'utf8');
  expect(skill).toContain("execute only the command supplied in that node's `with.ask`");
  expect(skill).toContain('On failure, stop the invocation so the graph follows its failure edge');
});

test('RELEASE-WIN-SMOKE mock world carries success and immediate libc failure receipts', () => {
  const world = parseYaml(readFileSync(join(pluginDir, 'sims/release-win-smoke.yaml'), 'utf8')) as {
    cases: Array<{ id: string; receipt: { terminal: string; steps: string[]; failure?: string; observation: string } }>;
  };
  expect(world.cases.map(run => run.id)).toEqual([
    'installer-version-capture-success',
    'missing-libc-fails-version-before-capture',
  ]);
  const success = world.cases.find(run => run.id === 'installer-version-capture-success')!;
  expect(success.receipt).toEqual({ terminal: 'done', steps: ['install', 'version', 'capture'], observation: 'release.win-smoke' });
  const failure = world.cases.find(run => run.id === 'missing-libc-fails-version-before-capture')!;
  expect(failure.receipt).toEqual({ terminal: 'failed', steps: ['install', 'version'], failure: 'libc.so.6 unavailable', observation: 'release.win-smoke' });
});
