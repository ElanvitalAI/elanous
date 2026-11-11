import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { graphInstanceViewIssues } from '../scripts/validate-graph-instance-view.js';

const fixture = (name: string): Record<string, any> => JSON.parse(readFileSync(
  join(import.meta.dir, '../plugins/graph-instance-view/fixtures', `${name}.view.json`), 'utf8'));

test('all four published v1 fixtures satisfy schema and identity references', () => {
  for (const source of ['graph', 'harness', 'release', 'resource']) {
    expect(graphInstanceViewIssues(fixture(source)), source).toEqual([]);
  }
});

test('graph and release identities require graphId', () => {
  for (const source of ['graph', 'release']) {
    const view = fixture(source);
    delete view.instance.graphId;
    expect(graphInstanceViewIssues(view).some(issue => issue.includes('required'))).toBe(true);
  }
});

test('release output cannot relabel another graph as release-loop', () => {
  const view = fixture('release');
  view.instance.graphId = 'ordinary-graph';
  expect(graphInstanceViewIssues(view)).not.toEqual([]);
});

test('cross-source power and execution states are rejected', () => {
  const graph = fixture('graph');
  graph.nodes[0].state = 'on';
  expect(graphInstanceViewIssues(graph)).not.toEqual([]);
  const resource = fixture('resource');
  resource.nodes[0].state = 'running';
  expect(graphInstanceViewIssues(resource)).not.toEqual([]);
});

test('node and edge IDs are unique and every shared reference resolves', () => {
  const cases: Array<[string, (view: Record<string, any>) => void, string]> = [
    ['duplicate node', view => { view.nodes[1].id = view.nodes[0].id; }, 'duplicate-node-id'],
    ['duplicate edge', view => { view.edges[1].id = view.edges[0].id; }, 'duplicate-edge-id'],
    ['edge source', view => { view.edges[0].from = 'missing'; }, 'missing-edge-from'],
    ['edge target', view => { view.edges[0].to = 'missing'; }, 'missing-edge-to'],
    ['active node', view => { view.progress.activeNodeIds = ['missing']; }, 'missing-active-node'],
    ['log node', view => { view.logs[0].nodeId = 'missing'; }, 'missing-log-node'],
  ];
  for (const [name, mutate, issue] of cases) {
    const view = fixture('graph');
    mutate(view);
    expect(graphInstanceViewIssues(view).some(item => item.startsWith(issue)), name).toBe(true);
  }
});
