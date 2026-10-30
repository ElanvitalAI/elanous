import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { appendPriorToGoal, childLlmSelectionFromRecipe, implementationRequestFromContext } from './headless-goal-loop.js';

const repositoryRoot = resolve(import.meta.dir, '../../..');

test('make-doc forwards the supplied research packet into the implementation goal', () => {
  const prior = {
    result: { title: 'Bun v1.4.3 release notes' },
    evidence: { source: 'https://bun.sh/blog/bun-v1.4.3', limitations: 'Vendor-reported data.' },
  };

  const goal = appendPriorToGoal('Write a short Korean release brief.', prior);

  expect(goal).toContain('## Supplied prior research and evidence');
  expect(goal).toContain(JSON.stringify(prior, null, 2));
  expect(appendPriorToGoal('Write a brief.', null)).toBe('Write a brief.');
});

test('recipe child model requires a complete provider and model pair', () => {
  expect(childLlmSelectionFromRecipe(undefined, undefined)).toBeUndefined();
  expect(childLlmSelectionFromRecipe('provider-test', 'model-test')).toEqual({
    provider: 'provider-test',
    model: 'model-test',
    source: 'config',
  });
  expect(() => childLlmSelectionFromRecipe('provider-test', undefined)).toThrow('requires both provider and model');
});

test('the implementation entry request carries prepare prior and the recipe child selection', () => {
  const prior = { evidence: { source: 'https://example.test/source' } };
  const request = implementationRequestFromContext({
    runId: 'run-test',
    input: { ask: 'Write the report.' },
    outputs: { prepare: { goal: 'Write the report.', prior } },
  }, {
    ELANOUS_GRAPH_CHILD_LLM_PROVIDER: 'provider-test',
    ELANOUS_GRAPH_CHILD_LLM_MODEL: 'model-test',
  });

  expect(request.runId).toBe('run-test');
  expect(request.feature).toContain(JSON.stringify(prior, null, 2));
  expect(request.childLlm).toEqual({ provider: 'provider-test', model: 'model-test', source: 'config' });
});

test('make-doc and verify rework use the configured-default recipe with its timeout', () => {
  const recipes = parseYaml(readFileSync(resolve(repositoryRoot, 'graphs/units/verbs/recipes.yaml'), 'utf8')) as Record<string, { command?: string; timeout_ms?: number }>;
  const makeDoc = parseYaml(readFileSync(resolve(repositoryRoot, 'graphs/units/verbs/make-doc.yaml'), 'utf8')) as { nodes: Array<{ node_id: string; recipe: string }> };
  const verify = parseYaml(readFileSync(resolve(repositoryRoot, 'graphs/units/verbs/verify.yaml'), 'utf8')) as { nodes: Array<{ node_id: string; recipe: string }> };
  const draftRecipe = makeDoc.nodes.find((node) => node.node_id === 'document-draft')?.recipe;
  const reworkRecipe = verify.nodes.find((node) => node.node_id === 'rework-loop')?.recipe;
  const configured = recipes['headless-goal-loop'];

  expect(draftRecipe).toBe('cmd:headless-goal-loop');
  expect(reworkRecipe).toBe(draftRecipe);
  expect(configured.timeout_ms).toBe(300000);
  expect(configured.command).toBe('bun "$ELANOUS_GRAPH_DIR/../../../scripts/graph-units/verbs/headless-goal-loop.ts"');
  expect(configured.command).not.toMatch(/ELANOUS_GRAPH_CHILD_LLM_(?:PROVIDER|MODEL)=/);
});
