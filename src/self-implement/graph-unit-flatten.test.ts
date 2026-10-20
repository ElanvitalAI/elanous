import { describe, expect, test } from 'bun:test';
import { flattenGraphUnits, type StaticGraphUnit } from './graph-unit-flatten.js';
import type { GraphTemplateSpec } from './graph-yaml.js';

const root: GraphTemplateSpec = {
  graphId: 'root', version: 1, entryNode: 'start', terminalNodes: ['done'],
  nodes: [
    { nodeId: 'start', kind: 'agent', recipe: 'start', maxVisits: 1 },
    { nodeId: 'unit-call', kind: 'subgraph', recipe: 'none', maxVisits: 1, call: 'unit@1',
      contract: { inputs: [], tools: 'read-only', outputs: [] } },
    { nodeId: 'done', kind: 'gate', recipe: 'none', maxVisits: 1 },
  ],
  edges: [
    { from: 'start', to: 'unit-call' },
    { from: 'unit-call', on: 'outcome', map: { completed: 'done' } },
  ],
};

const unit: GraphTemplateSpec = {
  graphId: 'unit', version: 1, entryNode: 'work', terminalNodes: ['completed'],
  unit: { inputs: [], outputs: [], exits: ['completed'] },
  nodes: [
    { nodeId: 'work', kind: 'agent', recipe: 'work', maxVisits: 1 },
    { nodeId: 'completed', kind: 'observe', recipe: 'none', maxVisits: 1 },
  ],
  edges: [{ from: 'work', to: 'completed' }],
};

describe('static graph unit flattening', () => {
  test('rewires caller entry and unit exit while preserving graph node/edge semantics', () => {
    const flat = flattenGraphUnits(root, '/graphs/root.yaml', () => ({ path: '/graphs/units/unit.yaml', template: unit }));
    expect(flat.entryNode).toBe('start');
    expect(flat.terminalNodes).toEqual(['done']);
    expect(flat.nodes.map((node) => node.nodeId)).toEqual(['start', 'done', 'unit-call__work']);
    expect(flat.edges).toEqual([
      { from: 'start', to: 'unit-call__work' },
      { from: 'unit-call__work', to: 'done' },
    ]);
    expect(flat.nodes.some((node) => node.call !== undefined)).toBe(false);
  });

  test('rewrites fallback destinations alongside ordinary unit edges', () => {
    const withFallback = { ...unit, edges: [{ from: 'work', to: 'completed', fallback: [{ node: 'completed', requires: ['simulated'] }] }] };
    const flat = flattenGraphUnits(root, '/graphs/root.yaml', () => ({ path: '/graphs/units/unit.yaml', template: withFallback }));
    expect(flat.edges).toEqual([
      { from: 'start', to: 'unit-call__work' },
      { from: 'unit-call__work', to: 'done', fallback: [{ node: 'done', requires: ['simulated'] }] },
    ]);
  });

  test('keeps a caller terminal when its id matches a child unit exit', () => {
    const caller = { ...root, terminalNodes: ['completed'], nodes: [
      ...root.nodes.filter((node) => node.nodeId !== 'done'),
      { nodeId: 'completed', kind: 'gate', recipe: 'none', maxVisits: 1 },
    ], edges: [
      { from: 'start', to: 'unit-call' },
      { from: 'unit-call', on: 'outcome', map: { completed: 'completed' } },
    ] } satisfies GraphTemplateSpec;
    const flat = flattenGraphUnits(caller, '/graphs/root.yaml', () => ({ path: '/graphs/units/unit.yaml', template: unit }));
    expect(flat.terminalNodes).toEqual(['completed']);
    expect(flat.nodes.some((node) => node.nodeId === 'completed')).toBe(true);
    expect(flat.edges.at(-1)).toEqual({ from: 'unit-call__work', to: 'completed' });
  });

  test('rejects child node ids that collide with existing caller nodes', () => {
    const caller = { ...root, nodes: [
      ...root.nodes,
      { nodeId: 'unit-call__work', kind: 'observe', recipe: 'none', maxVisits: 1 },
    ] } satisfies GraphTemplateSpec;
    expect(() => flattenGraphUnits(caller, '/graphs/root.yaml', () => ({ path: '/graphs/units/unit.yaml', template: unit })))
      .toThrow('flattened unit node collision: unit-call__work');
  });

  test('selects a declared non-default unit entry and rejects undeclared entries', () => {
    const multi = { ...unit, unit: { ...unit.unit!, entries: ['work', 'other'] }, nodes: [
      ...unit.nodes, { nodeId: 'other', kind: 'agent', recipe: 'other', maxVisits: 1 },
    ] } satisfies GraphTemplateSpec;
    const selected = { ...root, nodes: root.nodes.map((node) => node.nodeId === 'unit-call' ? { ...node, callEntry: 'other' } : node) };
    const flattened = flattenGraphUnits(selected, '/graphs/root.yaml', () => ({ path: '/graphs/units/unit.yaml', template: multi }));
    expect(flattened.entryNode).toBe('start');
    expect(flattened.edges[0]).toEqual({ from: 'start', to: 'unit-call__other' });
    expect(() => flattenGraphUnits({ ...selected, nodes: selected.nodes.map((node) => node.nodeId === 'unit-call' ? { ...node, callEntry: 'ghost' } : node) },
      '/graphs/root.yaml', () => ({ path: '/graphs/units/unit.yaml', template: multi }))).toThrow('unit entry mismatch');
  });

  test('rewrites a caller entry that is itself a unit call to the selected child entry', () => {
    const caller = { ...root, entryNode: 'unit-call' };
    const flat = flattenGraphUnits(caller, '/graphs/root.yaml', () => ({ path: '/graphs/units/unit.yaml', template: unit }));
    expect(flat.entryNode).toBe('unit-call__work');
  });

  test('uses already flattened destinations when a later unit exits into an earlier call', () => {
    const caller: GraphTemplateSpec = {
      graphId: 'nested-caller', version: 1, entryNode: 'start', terminalNodes: ['done'],
      nodes: [
        { nodeId: 'start', kind: 'agent', recipe: 'start', maxVisits: 1 },
        { nodeId: 'unit-b', kind: 'subgraph', recipe: 'none', maxVisits: 1, call: 'unit-b@1', contract: { inputs: [], tools: 'read-only', outputs: [] } },
        { nodeId: 'unit-a', kind: 'subgraph', recipe: 'none', maxVisits: 1, call: 'unit-a@1', contract: { inputs: [], tools: 'read-only', outputs: [] } },
        { nodeId: 'done', kind: 'gate', recipe: 'none', maxVisits: 1 },
      ],
      edges: [
        { from: 'start', to: 'unit-b' },
        { from: 'unit-b', on: 'outcome', map: { completed: 'done' } },
        { from: 'unit-a', on: 'outcome', map: { completed: 'unit-b' } },
      ],
    };
    const unitFor = (id: string): StaticGraphUnit => ({
      path: `/graphs/units/${id}.yaml`,
      template: {
        graphId: id, version: 1, entryNode: 'work', terminalNodes: ['completed'],
        unit: { inputs: [], outputs: [], exits: ['completed'] },
        nodes: [
          { nodeId: 'work', kind: 'agent', recipe: id, maxVisits: 1 },
          { nodeId: 'completed', kind: 'observe', recipe: 'none', maxVisits: 1 },
        ],
        edges: [{ from: 'work', to: 'completed' }],
      },
    });
    const flat = flattenGraphUnits(caller, '/graphs/root.yaml', (call) => unitFor(call.split('@')[0]!));
    expect(flat.nodes.map((node) => node.nodeId)).not.toContain('unit-b');
    expect(flat.edges).toContainEqual({ from: 'unit-a__work', to: 'unit-b__work' });
  });

  test('rewrites a caller exit mapped back into its own call to the flattened entry', () => {
    const retryCaller = {
      ...root,
      edges: [
        { from: 'start', to: 'unit-call' },
        { from: 'unit-call', on: 'outcome', map: { completed: 'unit-call' } },
      ],
    };
    const flat = flattenGraphUnits(retryCaller, '/graphs/root.yaml', () => ({ path: '/graphs/units/unit.yaml', template: unit }));
    expect(flat.nodes.map((node) => node.nodeId)).toEqual(['start', 'done', 'unit-call__work']);
    expect(flat.edges).toEqual([
      { from: 'start', to: 'unit-call__work' },
      { from: 'unit-call__work', to: 'unit-call__work' },
    ]);
  });

  test('rejects a selected unit entry exit mapped back into its own call', () => {
    const entryExitUnit: GraphTemplateSpec = {
      ...unit,
      entryNode: 'completed',
      unit: { ...unit.unit!, entries: ['completed'] },
      edges: [],
    };
    const retryCaller = {
      ...root,
      edges: [
        { from: 'start', to: 'unit-call' },
        { from: 'unit-call', on: 'outcome', map: { completed: 'unit-call' } },
      ],
    };

    expect(() => flattenGraphUnits(retryCaller, '/graphs/root.yaml', () => ({ path: '/graphs/units/unit.yaml', template: entryExitUnit })))
      .toThrow('unit entry exit cannot map back to its own call: unit-call -> completed');
  });
});
