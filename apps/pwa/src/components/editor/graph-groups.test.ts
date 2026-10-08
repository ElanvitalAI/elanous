import { describe, expect, test } from 'bun:test';
import { aggregateGroupState, collapseGroups, groupBoxes, groupNames, groupOf, type GroupedRunGraph } from './graph-groups';

const graph: GroupedRunGraph = {
  id: 'g', source: 'core', editable: false, entry_node: 'entrance', terminal_nodes: ['merge'],
  nodes: [
    { node_id: 'entrance', kind: 'observe', recipe: 'r', max_visits: 1, group: 'intake' },
    { node_id: 'queue', kind: 'observe', recipe: 'r', max_visits: 1, group: 'intake' },
    { node_id: 'implement', kind: 'agent', recipe: 'r', max_visits: 6 },
    { node_id: 'gate', kind: 'gate', recipe: 'r', max_visits: 6 },
    { node_id: 'open-pr', kind: 'git', recipe: 'r', max_visits: 2, group: 'land' },
    { node_id: 'merge', kind: 'git', recipe: 'r', max_visits: 2, group: 'land' },
  ],
  edges: [
    { from: 'entrance', to: 'queue' },
    { from: 'queue', to: 'implement' },
    { from: 'implement', to: 'gate' },
    { from: 'gate', on: 'outcome', map: { pass: 'open-pr', fail: 'implement' } },
    { from: 'open-pr', to: 'merge' },
  ],
};

describe('graph groups', () => {
  test('units come from the node group tag only', () => {
    expect(groupNames(graph)).toEqual(['intake', 'land']);
    expect(groupOf(graph).has('implement')).toBe(false);
    expect(groupNames({ ...graph, nodes: graph.nodes.map(({ group: _group, ...node }) => node) })).toEqual([]);
  });

  test('nothing collapsed ⇒ same graph, identity resolve', () => {
    const view = collapseGroups(graph, new Set());
    expect(view.graph).toBe(graph);
    expect(view.resolve('queue')).toBe('queue');
  });

  test('collapsing folds members into one node and rewires edges in and out', () => {
    const view = collapseGroups(graph, new Set(['intake', 'land']));
    expect(view.graph.nodes.map((node) => node.node_id)).toEqual(['group:intake', 'implement', 'gate', 'group:land']);
    expect(view.graph.entry_node).toBe('group:intake');
    expect(view.graph.terminal_nodes).toEqual(['group:land']);
    expect(view.graph.edges).toEqual([
      { from: 'group:intake', to: 'implement' },
      { from: 'implement', to: 'gate' },
      { from: 'gate', on: 'outcome', map: { pass: 'group:land', fail: 'implement' } },
    ]);
    expect(view.resolve('merge')).toBe('group:land');
    expect(view.graph.nodes[0]).toMatchObject({ kind: 'subgraph', max_visits: 1 });
  });

  test('same outcome from two members to different targets keeps both routes', () => {
    const split: GroupedRunGraph = {
      ...graph,
      nodes: [...graph.nodes, { node_id: 'heal', kind: 'agent', recipe: 'r', max_visits: 1 }],
      edges: [
        { from: 'entrance', on: 'outcome', map: { fail: 'heal', pass: 'queue' } },
        { from: 'queue', on: 'outcome', map: { fail: 'gate', pass: 'implement' } },
      ],
    };
    const view = collapseGroups(split, new Set(['intake']));
    expect(view.graph.edges).toEqual([{ from: 'group:intake', on: 'outcome', map: { fail: 'heal', 'fail·gate': 'gate', pass: 'implement' } }]);
  });

  test('a box wraps its members with padding and a header', () => {
    const boxes = groupBoxes([
      { id: 'open-pr', position: { x: 100, y: 50 }, width: 190, height: 70 },
      { id: 'merge', position: { x: 350, y: 50 }, width: 190, height: 86 },
      { id: 'gate', position: { x: 0, y: 0 }, width: 190, height: 70 },
    ], groupOf(graph));
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toMatchObject({ group: 'land', members: ['open-pr', 'merge'], x: 82, y: 6, width: 476, height: 148 });
  });

  test('unit state: running wins, then failed, then passed', () => {
    expect(aggregateGroupState(['passed', 'running'])).toBe('running');
    expect(aggregateGroupState(['passed', 'failed'])).toBe('failed');
    expect(aggregateGroupState(['pending', 'passed'])).toBe('passed');
    expect(aggregateGroupState(['pending'])).toBe('pending');
  });
});
