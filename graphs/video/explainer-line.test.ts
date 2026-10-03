import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseGraphTemplateYaml } from '../../src/self-implement/graph-yaml.js';
import { parsePluginManifest } from '../../src/plugins/core/manifest.js';
import { EXPLAINER } from '../../src/video-pipeline/recipes/explainer.js';

const yaml = readFileSync(join(import.meta.dir, 'explainer-line.yaml'), 'utf8');
const parsed = parseGraphTemplateYaml(yaml, 'explainer-line.yaml');
const spec = parsed.template!;

const recipes = [
  ['script', 'explainer-script', 'read-only', ['facts', 'sources'], ['script_path'], 3],
  ['vo', 'explainer-vo', 'network-write', ['script_path'], ['vo_dir', 'narration_seconds'], 2],
  ['build', 'explainer-build', 'workspace-write', ['script_path', 'vo_dir'], ['hyperframes_project', 'timeline_path'], 3],
  ['render', 'hyperframes-render', 'workspace-write', ['hyperframes_project'], ['hf_render_path', 'hf_snapshot_dir', 'hf_check'], 2],
  ['qc', 'explainer-qc', 'read-and-run', ['hf_render_path', 'script_path'], ['vo_match', 'loudness_lufs', 'true_peak_db'], 2],
] as const;

const routes: Record<string, Record<string, string>> = {
  script: { ok: 'vo', 'no-facts': 'needs-human', unmeasurable: 'unobserved' },
  vo: { ok: 'build', 'no-key': 'needs-human', error: 'blocked', unmeasurable: 'unobserved' },
  build: { ok: 'render', 'bad-script': 'script', error: 'blocked', unmeasurable: 'unobserved' },
  render: { ok: 'qc', 'check-fail': 'build', 'render-mismatch': 'build', unmeasurable: 'unobserved' },
  qc: { pass: 'delivered', 'vo-mismatch': 'vo', loudness: 'build', public: 'needs-human', unmeasurable: 'unobserved' },
};

describe('explainer-line declaration', () => {
  test('parses nodes, recipes and their contracts without the obsolete warning', () => {
    expect(parsed.errors).toEqual([]);
    expect(yaml).not.toContain('not yet coded');
    expect(spec.graphId).toBe('explainer-line');
    expect(spec.entryNode).toBe('script');
    expect(spec.terminalNodes).toEqual(['delivered', 'needs-human', 'blocked', 'unobserved']);
    expect(spec.nodes.map((node) => node.nodeId)).toEqual([...recipes.map(([id]) => id), ...spec.terminalNodes]);
    for (const [id, recipe, tools, inputs, outputs, maxVisits] of recipes) {
      const node = spec.nodes.find((n) => n.nodeId === id)!;
      expect(node.recipe).toBe(recipe);
      expect(node.contract).toEqual({ inputs, tools, outputs });
      expect(node.maxVisits).toBe(maxVisits);
    }
    for (const id of spec.terminalNodes) {
      const terminal = spec.nodes.find((node) => node.nodeId === id)!;
      expect(terminal.kind).toBe('judge');
      expect(terminal.recipe).toBe(`terminal-${id}`);
      expect(terminal.maxVisits).toBe(1);
    }
  });

  test('matches every declared edge and walks only ok/pass outcomes to delivered', () => {
    expect(Object.fromEntries(spec.edges.map((edge) => [edge.from, edge.map]))).toEqual(routes);
    const path = [spec.entryNode];
    while (!spec.terminalNodes.includes(path.at(-1)!)) {
      const id = path.at(-1)!;
      const edge = spec.edges.find((e) => e.from === id);
      expect(edge?.on).toBe('outcome');
      const next = edge?.map?.[id === 'qc' ? 'pass' : 'ok'];
      expect(next).toBeDefined();
      expect(path).not.toContain(next);
      path.push(next!);
    }
    expect(path).toEqual(['script', 'vo', 'build', 'render', 'qc', 'delivered']);
  });

  test('every explainer recipe in the graph is a key of EXPLAINER', () => {
    const declared = spec.nodes.map((node) => node.recipe)
      .filter((recipe) => !recipe.startsWith('terminal-') && recipe !== 'hyperframes-render');
    expect(declared.filter((recipe) => !(recipe in EXPLAINER))).toEqual([]);
    expect([...declared].sort()).toEqual(Object.keys(EXPLAINER).sort());
  });

  test('video-explainer 0.2.0 bundles and exposes its graph through the manifest parser', () => {
    const raw = JSON.parse(readFileSync(join(import.meta.dir, '../../packs/video-explainer/plugin.json'), 'utf8'));
    const extension = raw.extensions['ai.elanous'];
    expect(extension.bundle).toContainEqual({ from: 'graphs/video/explainer-line.yaml', as: 'graphs/explainer-line.yaml' });
    const manifest = parsePluginManifest(raw);
    expect(manifest.version).toBe('0.2.0');
    expect(manifest.contributes.graphs).toContain('graphs/explainer-line.yaml');
  });
});
