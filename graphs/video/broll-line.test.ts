import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseGraphTemplateYaml } from '../../src/self-implement/graph-yaml.js';
import { BROLL } from '../../src/video-pipeline/recipes/broll.js';

const file = join(import.meta.dir, 'broll-line.yaml');
const parsed = parseGraphTemplateYaml(readFileSync(file, 'utf8'), 'broll-line.yaml');
const spec = parsed.template!;

const recipes = [
  ['align', 'broll-align-words', 'network-write', ['audio_path'], ['aligned_words', 'narration_seconds']],
  ['plan', 'broll-density-plan', 'read-only', ['aligned_words', 'density_target'], ['broll_slots', 'target_clips']],
  ['clips', 'broll-select-clips', 'network-write', ['broll_slots', 'clips_dir'], ['broll_clips', 'skipped_clips']],
  ['assemble', 'broll-render', 'workspace-write', ['base_video', 'broll_clips', 'clips_dir'], ['rendered_path', 'rendered_clips']],
  ['qc', 'broll-qc', 'read-and-run', ['rendered_path', 'rendered_clips', 'density_target'], ['qc_pass', 'qc_seconds', 'density_actual']],
] as const;

const routes: Record<string, Record<string, string>> = {
  align: { ok: 'plan', error: 'blocked', unmeasurable: 'unobserved' },
  plan: { ok: 'clips', unmeasurable: 'unobserved' },
  clips: { ok: 'assemble', empty: 'skipped', unmeasurable: 'unobserved' },
  assemble: { ok: 'qc', empty: 'skipped', error: 'assemble', unmeasurable: 'unobserved' },
  qc: { pass: 'delivered', fail: 'assemble', unmeasurable: 'unobserved' },
};

describe('broll-line declaration', () => {
  test('parses with the five contract-bearing recipes and four terminal nodes', () => {
    expect(parsed.errors).toEqual([]);
    expect(spec.graphId).toBe('broll-line');
    expect(spec.entryNode).toBe('align');
    expect(spec.terminalNodes).toEqual(['delivered', 'skipped', 'blocked', 'unobserved']);
    expect(spec.nodes.map((n) => n.nodeId)).toEqual([...recipes.map(([id]) => id), ...spec.terminalNodes]);
    for (const [id, recipe, tools, inputs, outputs] of recipes) {
      const node = spec.nodes.find((n) => n.nodeId === id)!;
      expect(node.recipe).toBe(recipe);
      expect(node.contract).toEqual({ inputs, tools, outputs });
      expect(node.maxVisits).toBe(2);
    }
    for (const id of spec.terminalNodes) {
      const terminal = spec.nodes.find((n) => n.nodeId === id)!;
      expect(terminal.kind).toBe('judge');
      expect(terminal.maxVisits).toBe(1);
    }
  });

  test('routes every declared outcome and bounds retries at two visits', () => {
    expect(Object.fromEntries(spec.edges.map((e) => [e.from, e.map]))).toEqual(routes);
    expect(routes.assemble.error).toBe('assemble');
    expect(routes.qc.fail).toBe('assemble');
    const retries = spec.edges.flatMap((e) => Object.values(e.map ?? {}).filter((destination) =>
      destination === e.from || (e.from === 'qc' && destination === 'assemble')));
    expect(retries).toEqual(['assemble', 'assemble']);
    expect(spec.nodes.filter((n) => retries.includes(n.nodeId)).every((n) => n.maxVisits === 2)).toBe(true);
  });

  // The declaration and the recipe code were written apart and drifted once (names, state keys, outcomes).
  test('every non-terminal recipe exists in the BROLL export', () => {
    const declared = spec.nodes.filter((n) => !spec.terminalNodes.includes(n.nodeId)).map((n) => n.recipe);
    expect(declared.filter((r) => !(r in BROLL))).toEqual([]);
    expect(Object.keys(BROLL).sort()).toEqual([...declared].sort());
  });
});
