import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import type { GraphEdgeSpec, GraphTemplateSpec } from '../self-implement/graph-yaml.js';
import {
  applyAdaptiveGraphOperations,
  revisionForGraphSnapshot,
  type AdaptiveGraphOperation,
} from './graph-diff-apply.js';

// Source: 내부 문서 `RFC-graph-templates-as-yaml-five-phase-2026-09-08` §4.1; src/self-implement/graph-yaml.ts requires max_visits >= 1.
const FIXTURE_MAX_VISITS = 1;

const graph = (edges: readonly GraphEdgeSpec[] = []): GraphTemplateSpec => ({
  graphId: 'diff-test', version: 1, entryNode: 'a', terminalNodes: ['c'],
  nodes: ['a', 'b', 'c', 'd'].map((nodeId) => ({ nodeId, kind: 'decision', recipe: nodeId, maxVisits: FIXTURE_MAX_VISITS })),
  edges,
});

const validateTestCandidate = (_candidate: GraphTemplateSpec) => {};

describe('atomic adaptive graph diff application', () => {
  test('does not expose partial edits when the final candidate is invalid', () => {
    const original = graph([{ from: 'a', to: 'b' }]);
    const operations: AdaptiveGraphOperation[] = [
      { op: 'remove', nodeId: 'c' },
      { op: 'add', node: { nodeId: 'e', kind: 'decision', recipe: 'e', maxVisits: FIXTURE_MAX_VISITS }, edges: [] },
    ];

    expect(() => applyAdaptiveGraphOperations(original, operations, validateTestCandidate)).toThrow('adaptive graph terminal missing: c');
    expect(original.nodes.map((node) => node.nodeId)).toEqual(['a', 'b', 'c', 'd']);
    expect(original.edges).toEqual([{ from: 'a', to: 'b' }]);
  });

  test('allows a remove/add replacement sequence and validates only its final graph', () => {
    const original = graph([{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }]);
    const result = applyAdaptiveGraphOperations(original, [
      { op: 'remove', nodeId: 'b' },
      { op: 'add', node: { nodeId: 'b', kind: 'decision', recipe: 'replacement', maxVisits: FIXTURE_MAX_VISITS }, edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'd' }] },
    ], validateTestCandidate);

    expect(result.graph.nodes.find((node) => node.nodeId === 'b')?.recipe).toBe('replacement');
    expect(result.graph.edges).toEqual([{ from: 'a', to: 'b' }, { from: 'b', to: 'd' }]);
  });

  test('preserves entry and terminal declarations when their node is replaced atomically', () => {
    const original = graph([{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }]);
    const result = applyAdaptiveGraphOperations(original, [
      { op: 'remove', nodeId: 'a' },
      { op: 'add', node: { nodeId: 'a', kind: 'decision', recipe: 'new-entry', maxVisits: FIXTURE_MAX_VISITS }, edges: [{ from: 'a', to: 'b' }] },
      { op: 'remove', nodeId: 'c' },
      { op: 'add', node: { nodeId: 'c', kind: 'decision', recipe: 'new-terminal', maxVisits: FIXTURE_MAX_VISITS }, edges: [] },
    ], validateTestCandidate);

    expect(result.graph.entryNode).toBe('a');
    expect(result.graph.terminalNodes).toEqual(['c']);
    expect(result.graph.nodes.find((node) => node.nodeId === 'a')?.recipe).toBe('new-entry');
    expect(result.graph.nodes.find((node) => node.nodeId === 'c')?.recipe).toBe('new-terminal');
  });

  test('removing a node removes dangling primary and fallback routes while keeping other routes', () => {
    const original = graph([{ from: 'a', to: 'b', fallback: [
      { node: 'b', requires: ['expert'] }, { node: 'c', requires: ['expert'] },
    ] }]);
    const result = applyAdaptiveGraphOperations(original, [{ op: 'remove', nodeId: 'b' }], validateTestCandidate);

    expect(result.graph.edges).toEqual([{ from: 'a', fallback: [{ node: 'c', requires: ['expert'] }] }]);
    expect(result.graph.nodes.map((node) => node.nodeId)).not.toContain('b');
  });

  test('computes invalidation over the union of old and new downstream routes', () => {
    const original = graph([{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }]);
    const result = applyAdaptiveGraphOperations(original, [{
      op: 'replace', node: { nodeId: 'b', kind: 'decision', recipe: 'b2', maxVisits: FIXTURE_MAX_VISITS },
      edges: [{ from: 'b', to: 'd' }],
    }], validateTestCandidate);

    expect(result.invalidatedNodeIds).toEqual(['b', 'c', 'd']);
  });

  test('runs the caller full-schema validator on the final candidate before returning', () => {
    const original = graph();
    const operations: AdaptiveGraphOperation[] = [
      { op: 'add', node: { nodeId: 'e', kind: 'decision', recipe: 'invalid-for-caller', maxVisits: FIXTURE_MAX_VISITS }, edges: [] },
    ];
    const validate = (candidate: GraphTemplateSpec) => {
      if (candidate.nodes.some((node) => node.nodeId === 'e')) throw new Error('production graph schema rejected candidate');
    };

    expect(() => applyAdaptiveGraphOperations(original, operations, validate)).toThrow('production graph schema rejected candidate');
    expect(original.nodes.map((node) => node.nodeId)).not.toContain('e');
  });

  test('keeps source and operation nested data isolated when the final validator mutates then rejects', () => {
    const base = graph([{ from: 'a', to: 'b', map: { ok: 'c' } }]);
    const original: GraphTemplateSpec = { ...base, nodes: base.nodes.map((node) => node.nodeId === 'a'
      ? { ...node, input: { nested: { value: 'source' } } } : node) };
    const addedNode = { nodeId: 'e', kind: 'decision', recipe: 'e', maxVisits: FIXTURE_MAX_VISITS, input: { nested: { value: 'operation' } } };
    const operations: AdaptiveGraphOperation[] = [{ op: 'add', node: addedNode, edges: [{ from: 'e', to: 'b' }] }];
    const validate = (candidate: GraphTemplateSpec) => {
      ((candidate.nodes.find((node) => node.nodeId === 'a')!.input as { nested: { value: string } }).nested.value) = 'mutated';
      ((candidate.edges[0]!.map as Record<string, string>).ok) = 'd';
      ((candidate.nodes.find((node) => node.nodeId === 'e')!.input as { nested: { value: string } }).nested.value) = 'mutated';
      throw new Error('schema validator rejected candidate');
    };

    expect(() => applyAdaptiveGraphOperations(original, operations, validate)).toThrow('schema validator rejected candidate');
    expect((original.nodes.find((node) => node.nodeId === 'a')!.input as { nested: { value: string } }).nested.value).toBe('source');
    expect(original.edges[0]!.map?.ok).toBe('c');
    expect(addedNode.input.nested.value).toBe('operation');
  });

  test('rejects validator mutation when validation returns normally', () => {
    const original = graph([{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }]);
    const validate = (candidate: GraphTemplateSpec) => {
      (candidate.nodes as GraphTemplateSpec['nodes'][number][]).splice(0, 1);
      (candidate.edges[0] as { from: string; to: string }).to = 'not-published';
    };
    expect(() => applyAdaptiveGraphOperations(original, [{
      op: 'replace', node: { nodeId: 'b', kind: 'decision', recipe: 'b-next', maxVisits: FIXTURE_MAX_VISITS },
    }], validate)).toThrow('adaptive graph candidate validator must not mutate its input');

    expect(original.nodes.map((node) => node.nodeId)).toEqual(['a', 'b', 'c', 'd']);
    expect(original.edges[0]).toEqual({ from: 'a', to: 'b' });
  });

  test('binds a run snapshot hash to exactly one published graph revision', () => {
    const sha = (yaml: string) => createHash('sha256').update(yaml).digest('hex');
    const revisions = [{ revision: 1, yaml: 'version: 1\nnodes: [a]\n' }, { revision: 2, yaml: 'version: 2\nnodes: [a]\n' }];

    expect(revisionForGraphSnapshot(revisions, sha(revisions[0]!.yaml))).toBe(1);
    expect(revisionForGraphSnapshot(revisions, sha(revisions[1]!.yaml))).toBe(2);
    expect(() => revisionForGraphSnapshot(revisions, sha('unpublished graph'))).toThrow('run graph snapshot does not match a published revision');
    expect(() => revisionForGraphSnapshot([
      { revision: 1, yaml: revisions[0]!.yaml }, { revision: 2, yaml: revisions[0]!.yaml },
    ], sha(revisions[0]!.yaml))).toThrow('run graph snapshot does not match a published revision');
    expect(() => revisionForGraphSnapshot([
      { revision: 1, yaml: revisions[0]!.yaml }, { revision: 1, yaml: revisions[1]!.yaml },
    ], sha(revisions[0]!.yaml))).toThrow('published graph revisions contain duplicate revision numbers');
  });
});
