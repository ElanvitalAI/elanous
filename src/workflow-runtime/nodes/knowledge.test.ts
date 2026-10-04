import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeKnowledgeNode } from './knowledge.js';
import { isKnowledgeNode, validateWorkflow } from '../schema.js';
import { runWorkflowToCompletion } from '../executor.js';
import { getNodeSpec } from '../node-catalog.js';
import type { KnowledgeNode, NodeExecContext, WorkflowDeps } from '../types.js';

const node: KnowledgeNode = { id: 'notes', knowledge: { query: '$ARGUMENTS' } };
const ctx: NodeExecContext = {
  arguments: 'search text', artifactsDir: '/tmp/knowledge-test', outputs: {},
  resolvedProvider: undefined, resolvedModel: undefined, toolPolicy: {},
};
const deps: WorkflowDeps = {
  callLLM: async () => '',
  runBash: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
};
const match = (n: number) => ({ path: `dir/note-${n}.md`, lineNumber: n, snippet: 'X'.repeat(450) });

test('schema accepts knowledge query strings and rejects malformed query and limit', () => {
  expect(isKnowledgeNode(node)).toBe(true);
  expect(isKnowledgeNode({ id: 'bad', knowledge: { query: 1 } } as unknown as KnowledgeNode)).toBe(false);
  expect(isKnowledgeNode({ id: 'bad', knowledge: null } as unknown as KnowledgeNode)).toBe(false);
  const check = (body: unknown) => validateWorkflow({ name: 'notes-search', description: 'notes', nodes: [{ id: 'notes', knowledge: body }] });
  expect(check({ query: '$ARGUMENTS', limit: 3 }).ok).toBe(true);
  expect(check({ query: 12 }).issues.map(i => i.path)).toContain('nodes[0].knowledge.query');
  expect(check({ query: 'a', limit: 0 }).issues.map(i => i.path)).toContain('nodes[0].knowledge.limit');
});

test('one dispatch with interpolated query, default five and capped prompt-ready snippets; raw matches remain available', async () => {
  const matches = Array.from({ length: 6 }, (_, i) => match(i + 1));
  const calls: unknown[] = [];
  const result = await executeKnowledgeNode(node, ctx, {
    ...deps,
    searchObsidian: async args => {
      calls.push(args);
      return { output: 'tool summary', matches };
    },
  });
  expect(calls).toEqual([{ query: 'search text', limit: 5 }]);
  expect(result.ok).toBe(true);
  expect(result.output).toBe(matches.slice(0, 5)
    .map(m => `— ${m.path}:${m.lineNumber}\n${m.snippet.slice(0, 400)}`).join('\n\n'));
  expect(result.matches).toBe(matches);
  expect(result.error).toBeUndefined();
});

test('explicit limit and upstream $<id>.output interpolation', async () => {
  let args: unknown;
  const result = await executeKnowledgeNode({ id: 'notes', knowledge: { query: '$source.output topic', limit: 1 } }, {
    ...ctx, outputs: { source: { ok: true, output: 'vault', durationMs: 0 } },
  }, { ...deps, searchObsidian: async input => { args = input; return { output: '', matches: [match(1), match(2)] }; } });
  expect(args).toEqual({ query: 'vault topic', limit: 1 });
  expect(result.output).toBe(`— dir/note-1.md:1\n${'X'.repeat(400)}`);
});

test('zero matches, reported search error, and thrown search all succeed with empty text and reasons', async () => {
  for (const [searchObsidian, expected] of [
    [async () => ({ output: '', matches: [] }), 'no matches'],
    [async () => ({ output: 'tool error', matches: [], error: 'rg-exit-2' }), 'rg-exit-2'],
    [async () => { throw new Error('rg unavailable'); }, 'rg unavailable'],
  ] as const) {
    const result = await executeKnowledgeNode(node, ctx, { ...deps, searchObsidian });
    expect(result).toMatchObject({ ok: true, output: '', matches: [], error: expected });
  }
});

test('workflow dispatch passes the knowledge text to a downstream prompt even on search failure', async () => {
  const artifactsDir = mkdtempSync(join(tmpdir(), 'knowledge-workflow-'));
  try {
    for (const failing of [false, true]) {
      const prompts: string[] = [];
      const result = await runWorkflowToCompletion({
        workflow: { name: 'notes-search', description: 'notes', nodes: [
          node, { id: 'answer', depends_on: ['notes'], prompt: 'Use $notes.output' },
        ] }, arguments: 'search text', artifactsDir, ignorePins: true,
      }, {
        ...deps,
        searchObsidian: async () => failing
          ? { output: '', matches: [], error: 'vault unavailable' }
          : { output: '', matches: [match(1)] },
        callLLM: async ({ prompt }) => { prompts.push(prompt); return 'done'; },
      });
      expect(result.ok).toBe(true);
      expect(result.events).toContainEqual(expect.objectContaining({ type: 'node_start', nodeId: 'notes', nodeType: 'knowledge' }));
      expect(result.outputs.notes).toMatchObject({ ok: true, ...(failing ? { error: 'vault unavailable' } : {}) });
      expect(result.outputs.answer?.output).toBe('done');
      expect(prompts).toEqual([`Use ${result.outputs.notes?.output}`]);
      if (failing) expect(result.outputs.notes?.output).toBe('');
      else expect(String(result.outputs.notes?.output).startsWith('— dir/note-1.md:1')).toBe(true);
    }
  } finally {
    rmSync(artifactsDir, { recursive: true, force: true });
  }
});

test('catalog exposes knowledge query, limit and YAML example', () => {
  expect(getNodeSpec('knowledge')).toMatchObject({
    kind: 'knowledge', category: 'transform', summary: '볼트 검색 · 찾은 조각을 다음 노드에',
    yamlKey: 'knowledge', required: ['query'], optional: ['limit'],
    example: '- id: notes\n  knowledge:\n    query: $ARGUMENTS\n    limit: 3',
  });
});
