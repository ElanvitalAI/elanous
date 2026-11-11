import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { runGraph } from '../src/graph-runner/runner.js';

const graphPath = resolve(import.meta.dir, '../graphs/demo/solar-scene4.yaml');
const recipesPath = resolve(import.meta.dir, '../graphs/demo/recipes.yaml');

test('Solar scene four runs one declared LLM decision and persists its summary receipt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'solar-scene4-'));
  const prompts: string[] = [];
  try {
    const state = await runGraph(graphPath, { runId: 'solar-fake', input: 'Summarize the reviewed demo plan',
      deps: { root, callLLM: async prompt => {
        prompts.push(prompt);
        return JSON.stringify({ outcome: 'ok', summary: 'Reviewed plan is ready', reason: 'The second review passed' });
      } } });
    expect(state.status).toBe('done');
    // Source: solar-scene4.yaml has one prompt node after the second review and before publish.
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('Build result: {"outcome":"ok","artifact":"scene-four build draft"');
    expect(prompts[0]).toContain('Review evidence: {"outcome":"ok","findings":"draft meets the demo acceptance check"');
    expect(prompts[0]).toContain('second review of scene-four build draft passed');
    expect(prompts[0]).toContain('Summarize the reviewed demo plan');
    expect(state.path).toEqual(['plan', 'build', 'review', 'build', 'review', 'solar-summary', 'publish', 'done']);
    const decision = state.nodes.find(node => node.nodeId === 'solar-summary');
    expect(decision).toMatchObject({ ok: true, executed: true });
    expect(JSON.parse(decision?.output as string)).toEqual({
      outcome: 'ok', summary: 'Reviewed plan is ready', reason: 'The second review passed',
    });
    const receipt = JSON.parse(readFileSync(state.statePath, 'utf8')) as typeof state;
    expect(receipt.nodes.find(node => node.nodeId === 'solar-summary')?.output).toBe(decision?.output);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Solar decision failure blocks publish and the declaration points to the prompt recipe', async () => {
  const root = mkdtempSync(join(tmpdir(), 'solar-scene4-fail-'));
  try {
    const graph = parseYaml(readFileSync(graphPath, 'utf8')) as {
      nodes: Array<{ node_id: string; kind: string; recipe: string }>;
      edges: Array<{ from: string; map: Record<string, string> }>;
    };
    const recipes = parseYaml(readFileSync(recipesPath, 'utf8')) as Record<string, { prompt?: string }>;
    expect(graph.nodes.filter(node => node.kind === 'prompt')).toEqual([
      expect.objectContaining({ node_id: 'solar-summary', recipe: 'prompt:solar-summary' }),
    ]);
    expect(recipes['solar-summary']?.prompt).toContain('$build.output');
    expect(recipes['solar-summary']?.prompt).toContain('$review.output');
    expect(graph.edges.find(edge => edge.from === 'solar-summary')?.map).toEqual({ ok: 'publish', fail: 'failed', error: 'failed' });
    const state = await runGraph(graphPath, { runId: 'solar-fake-fail', deps: { root,
      callLLM: async () => JSON.stringify({ outcome: 'fail', summary: 'Not ready', reason: 'Review evidence is insufficient' }),
    } });
    expect(state.status).toBe('failed');
    expect(state.path.at(-1)).toBe('failed');
    expect(state.path).not.toContain('publish');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
