import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPluginManifestFromDir } from '../plugins/core/manifest.js';
import { compilePluginYaml } from '../plugins/core/plugin-yaml.js';
import { installPlugin } from '../plugins/install/plugin-install.js';
import { loadGraphPluginFromDir } from '../graph-runner/graph-manifest-loader.js';

export interface PluginYamlGenObservation {
  readonly installed: boolean;
  readonly generatedManifestMatches: boolean;
  readonly graphIds: readonly string[];
  readonly capabilities: readonly string[];
}

/** Runs a code-free plugin.yaml bundle through generation, install, and manifest loading. */
export async function simulatePluginYamlGen(): Promise<PluginYamlGenObservation> {
  const root = mkdtempSync(join(tmpdir(), 'plugin-yaml-gen-sim-'));
  const source = join(root, 'absorb');
  const graphDir = join(source, 'graph');
  mkdirSync(graphDir, { recursive: true });
  try {
    writeFileSync(join(source, 'plugin.yaml'), [
      'apiVersion: elanous.dev/plugin/v2',
      'id: absorb',
      'name: Absorb',
      'version: 1.0.0',
      'description: Code-free member absorption and briefing graphs.',
      'graphs: [./graph/absorb-brief.yaml]',
      'capabilities: [store, extract, llm-judge]',
      '',
    ].join('\n'));
    writeFileSync(join(graphDir, 'absorb-brief.yaml'), [
      'apiVersion: elanous.dev/graph/v2',
      'graph: { id: absorb-brief, version: 1.0.0, layer: flow, purpose: "Absorb and brief member scraps" }',
      'graph_id: absorb-brief',
      'version: 1',
      'entry_node: done',
      'terminal_nodes: [done]',
      'nodes:',
      '  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }',
      'edges: []',
      'allow: { recipes: [], skills: [absorb/*], mcp: [] }',
      'packs: []',
      'policy: { hitl: [] }',
      'observe: { categories: [graph.run, absorb.brief] }',
      '',
    ].join('\n'));
    const generated = compilePluginYaml(source);
    writeFileSync(join(source, 'plugin.json'), generated);
    const installed = await installPlugin(source, { root: join(root, 'state'), yes: true });
    const loaded = loadPluginManifestFromDir(installed.path, { id: installed.name });
    const loadedGraph = loadGraphPluginFromDir(installed.path);
    const committed = readFileSync(join(installed.path, 'plugin.json'), 'utf8');
    return {
      installed: installed.name === 'absorb' && loaded.manifest.id === 'absorb',
      generatedManifestMatches: committed === compilePluginYaml(installed.path),
      graphIds: Object.keys(loadedGraph.graphs),
      capabilities: (JSON.parse(committed).extensions['ai.elanous'].capabilities as string[]),
    };
  } finally { rmSync(root, { recursive: true, force: true }); }
}
