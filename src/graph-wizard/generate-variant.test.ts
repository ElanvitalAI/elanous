import { expect, test } from 'bun:test';
import { GRAPH_SPECS } from '../self-implement/graph-templates.js';
import { designGraphVariantPlan, listKnownGraphUnits } from './generate.js';

const template = GRAPH_SPECS['self-implement']!;
const input = { goal: 'g_ambiguous_docs', prompt: '문서와 코드를 함께 바꾼다. 검증 반복 상한을 어떻게 잡을까?', template };

test('one fake designer call lists known units first and returns only a validated variant plan', async () => {
  const units = [{ id: 'verb-verify', call: 'verb-verify@1', inputs: ['ask'], outputs: ['result'], exits: ['done'] }];
  const prompts: string[] = [];
  const result = await designGraphVariantPlan({ ...input, knownUnits: units }, {
    callLLM: async (prompt) => {
      prompts.push(prompt);
      return JSON.stringify({ maxVisits: { rework: 5 } });
    },
  });
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toStartWith('알려진 그래프 유닛');
  expect(prompts[0]).toContain('verb-verify@1');
  expect(prompts[0]).toContain('전체 YAML 대신 GraphVariantPlan JSON 객체 하나만 출력하라');
  expect(result.status).toBe('composed');
  if (result.status !== 'composed') return;
  expect(result.plan).toEqual({ maxVisits: { rework: 5 } });
  expect(result.variant.patches).toHaveLength(1);
  expect(result.variant.template.nodes.find((node) => node.nodeId === 'rework')?.maxVisits).toBe(5);
  expect(template.nodes.find((node) => node.nodeId === 'rework')?.maxVisits).not.toBe(5);
});

test('rejected authority plan falls back to the unchanged standard template', async () => {
  const result = await designGraphVariantPlan(input, { callLLM: async () => JSON.stringify({
    routes: [{ from: 'open-pr', outcome: 'pass', to: 'merge' }],
  }) });
  expect(result.status).toBe('fallback-standard');
  if (result.status !== 'fallback-standard') return;
  expect(result.template).toBe(template);
  expect(result.reason).toContain('variant-rejected');
});

test('invented unit and whole YAML output cannot be promoted to a variant', async () => {
  const unit = { id: 'verb-verify', call: 'verb-verify@1', inputs: [], outputs: [], exits: ['done'] };
  const growth = { node: { nodeId: 'invented', kind: 'subgraph', recipe: 'none', maxVisits: 1, call: 'fake@1',
    contract: { inputs: [], tools: 'read-only', outputs: [] } }, from: 'review', outcome: 'invented', returnTo: 'rework' };
  const invalidUnit = await designGraphVariantPlan({ ...input, knownUnits: [unit] }, { callLLM: async () => JSON.stringify({ growth }) });
  expect(invalidUnit.status).toBe('fallback-standard');
  const yaml = await designGraphVariantPlan(input, { callLLM: async () => 'graph_id: replacement\nnodes: []' });
  expect(yaml.status).toBe('fallback-standard');
});

test('a known unit can be proposed as one contracted subgraph growth node', async () => {
  const unit = { id: 'release-gate-recheck', call: 'release-gate-recheck@1', inputs: ['version'], outputs: ['planPath'], exits: ['done', 'failed'] };
  const growth = { node: { nodeId: 'gate-recheck', kind: 'subgraph', recipe: 'none', maxVisits: 1, call: unit.call,
    contract: { inputs: ['version'], tools: 'read-only', outputs: ['planPath'] } }, from: 'review', outcome: 'recheck', returnTo: 'review' };
  const result = await designGraphVariantPlan({ ...input, knownUnits: [unit] }, { callLLM: async () => JSON.stringify({ growth }) });
  expect(result.status).toBe('composed');
  if (result.status !== 'composed') return;
  expect(result.plan).toEqual({ growth });
  expect(result.variant.template.nodes.find((node) => node.nodeId === 'gate-recheck')?.call).toBe(unit.call);
  expect(result.variant.patches).toHaveLength(3);
});

test('a known unit with mismatched input or output contract falls back to the standard graph', async () => {
  const unit = { id: 'release-gate-recheck', call: 'release-gate-recheck@1', inputs: ['version', 'commit'], outputs: ['planPath'], exits: ['done', 'failed'] };
  for (const contract of [
    { inputs: ['commit', 'version'], tools: 'read-only', outputs: ['planPath'] },
    { inputs: ['version', 'commit'], tools: 'read-only', outputs: [] },
  ]) {
    const growth = { node: { nodeId: 'gate-recheck', kind: 'subgraph', recipe: 'none', maxVisits: 1, call: unit.call,
      contract }, from: 'review', outcome: 'recheck', returnTo: 'review' };
    let seenPrompt = '';
    const result = await designGraphVariantPlan({ ...input, knownUnits: [unit] }, { callLLM: async (prompt) => {
      seenPrompt = prompt;
      return JSON.stringify({ growth });
    } });
    expect(seenPrompt).toContain('inputs=version,commit · outputs=planPath');
    expect(seenPrompt).toContain('순서까지 그대로 복사');
    expect(result.status).toBe('fallback-standard');
    if (result.status === 'fallback-standard') expect(result.template).toBe(template);
  }
});

test('known units are read from validated unit templates', () => {
  const units = listKnownGraphUnits();
  expect(units.some((unit) => unit.call === 'verb-verify@1')).toBe(true);
  expect(units.every((unit) => unit.inputs && unit.outputs && unit.exits)).toBe(true);
});
