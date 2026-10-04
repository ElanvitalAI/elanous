import { expect, test } from 'bun:test';
import { HARNESS_CORE_KINDS, WORKFLOW_CORE_KINDS, hasNodeKind, listNodeKinds, registerCoreKinds, registerNodeKind } from './registry.js';
import { WORKFLOW_NODE_VARIANT_KEYS } from '../workflow-runtime/schema.js';
import { parseGraphTemplateYaml } from '../self-implement/graph-yaml.js';

const plugin = { graph: 'harness' as const, kind: 'job-coach:ncs-lookup', plugin: 'job-coach', description: 'Look up an NCS job', core: false };
const yaml = (kind: string) => `graph_id: t\nversion: 1\nentry_node: a\nterminal_nodes: [a]\nnodes: [{ node_id: a, kind: ${kind}, recipe: r, max_visits: 1 }]\nedges: []`;

test('core catalog shares the parser vocabulary, is idempotent and graph-scoped', () => {
  registerCoreKinds();
  registerCoreKinds();
  expect(listNodeKinds('harness').filter((kind) => kind.core).map((kind) => kind.kind)).toEqual([...HARNESS_CORE_KINDS]);
  expect(listNodeKinds('workflow').filter((kind) => kind.core).map((kind) => kind.kind)).toEqual([...WORKFLOW_NODE_VARIANT_KEYS]);
  expect(WORKFLOW_CORE_KINDS).toHaveLength(24);
  expect(WORKFLOW_CORE_KINDS).toContain('knowledge');
  expect(WORKFLOW_CORE_KINDS).toContain('subworkflow');
  expect(HARNESS_CORE_KINDS).toHaveLength(7);
  expect(listNodeKinds('workflow').filter((entry) => entry.core).every((entry) => entry.description.length > 0)).toBe(true);
  expect(hasNodeKind('workflow', 'hitl')).toBe(false);
  expect(hasNodeKind('harness', 'approval')).toBe(false);
});

test('registered plugin kind parses only after registration; collisions and invalid names are rejected', () => {
  expect(parseGraphTemplateYaml(yaml(plugin.kind)).errors.some((issue) => issue.path.endsWith('/kind'))).toBe(true);
  expect(registerNodeKind(plugin)).toEqual({ ok: true });
  expect(parseGraphTemplateYaml(yaml(plugin.kind)).template?.nodes[0]?.kind).toBe(plugin.kind);
  expect(registerNodeKind(plugin)).toEqual({ ok: false, reason: 'duplicate' });
  expect(registerNodeKind({ ...plugin, kind: 'agent' })).toEqual({ ok: false, reason: 'core-kind' });
  expect(registerNodeKind({ ...plugin, kind: 'other:x' })).toEqual({ ok: false, reason: 'bad-name' });
  expect(registerNodeKind({ ...plugin, kind: 'job-coach:x:y' })).toEqual({ ok: false, reason: 'bad-name' });
  expect(listNodeKinds('harness').filter((kind) => kind.kind === plugin.kind)).toHaveLength(1);
});

test('MCP run accepts gateway names and rejects empty, invalid, or mixed executor specs', () => {
  const entry = (kind: string, run: unknown) => ({
    graph: 'workflow' as const, kind: `demo:${kind}`, plugin: 'demo', description: 'mcp', core: false,
    run: run as { mcp: { server: string; tool: string; args?: Record<string, unknown> } },
  });
  const valid = { mcp: { server: 'ncs_1', tool: 'search-units', args: { limit: '{{inputs.limit}}' } } };
  expect(registerNodeKind(entry('mcp-valid', valid))).toEqual({ ok: true });
  expect(listNodeKinds('workflow').find((kind) => kind.kind === 'demo:mcp-valid')?.run).toEqual(valid);
  for (const [kind, spec] of [
    ['empty-server', { server: '', tool: 'search' }],
    ['empty-tool', { server: 'ncs', tool: '' }],
    ['bad-server', { server: 'NCS', tool: 'search' }],
    ['bad-tool', { server: 'ncs', tool: 'search.units' }],
    ['bad-args', { server: 'ncs', tool: 'search', args: [] }],
    ['numeric-server', { server: 123, tool: 'search' }],
    ['numeric-tool', { server: 'ncs', tool: 456 }],
    ['object-server', { server: { toString: () => 'ncs' }, tool: 'search' }],
    ['object-tool', { server: 'ncs', tool: { toString: () => 'search' } }],
  ] as const) {
    expect(registerNodeKind(entry(kind, { mcp: spec }))).toEqual({ ok: false, reason: 'bad-name' });
  }
  expect(registerNodeKind(entry('mixed', { ...valid, bash: 'echo x' }))).toEqual({ ok: false, reason: 'bad-name' });
});

test('workflow kind keeps its run body; harness and core kinds cannot carry one', () => {
  const run = { bash: 'printf %s {{inputs.msg}}' };
  expect(registerNodeKind({ graph: 'workflow', kind: 'demo:keeps-run', plugin: 'demo', description: 'echo', core: false, run })).toEqual({ ok: true });
  expect(listNodeKinds('workflow').find((kind) => kind.kind === 'demo:keeps-run')?.run).toEqual(run);
  expect(registerNodeKind({ ...plugin, kind: 'job-coach:with-run', run })).toEqual({ ok: false, reason: 'bad-name' });
  expect(registerNodeKind({ graph: 'workflow', kind: 'bash', description: 'x', core: true, run })).toEqual({ ok: false, reason: 'core-kind' });
});
