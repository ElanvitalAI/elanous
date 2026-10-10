import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectRecipesAgainstCatalog, loadNodeCatalog } from './graph-catalog.js';
import { parseGraphTemplateYaml, type GraphTemplateSpec } from './graph-yaml.js';

const catalog = loadNodeCatalog();

function graph(kind: string, recipe: string): GraphTemplateSpec {
  const result = parseGraphTemplateYaml(`
graph_id: catalog-check
version: 1
entry_node: check
terminal_nodes: [check]
nodes: [{ node_id: check, kind: ${kind}, recipe: "${recipe}", max_visits: 1 }]
edges: []
`);
  expect(result.errors).toEqual([]);
  expect(result.template).toBeDefined();
  return result.template!;
}

describe('node catalog declaration inspection', () => {
  test('default catalog loads role details and all active kinds', () => {
    expect(catalog.kinds).toEqual(['agent', 'gate', 'git', 'judge', 'observe', 'hitl', 'prompt', 'subgraph']); // #25170 prompt 종류
    expect(catalog.roles.get('observe-logs')).toEqual({
      kind: 'observe', outcomes: ['ok', 'empty'], spawn: 'runtime', grain: 'atom', effects: 'none',
    });
  });

  test('explicit path loads an isolated catalog rather than the default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'graph-catalog-'));
    try {
      const path = join(dir, 'catalog.yaml');
      writeFileSync(path, 'kinds:\n  existing: [observe]\n  proposed: {}\nroles:\n  - { role: local, kind: observe, outcomes: [ok], spawn: runtime, grain: atom, effects: none }\n');
      expect(loadNodeCatalog(path)).toEqual({
        kinds: ['observe'],
        roles: new Map([['local', { kind: 'observe', outcomes: ['ok'], spawn: 'runtime', grain: 'atom', effects: 'none' }]]),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('matching observe role parses and has no issues', () => {
    expect(inspectRecipesAgainstCatalog(graph('observe', 'observe-logs'), catalog)).toEqual([]);
    expect(inspectRecipesAgainstCatalog(graph('hitl', 'approval'), catalog)).toEqual([]);
    expect(inspectRecipesAgainstCatalog(graph('subgraph', 'heal'), catalog)).toEqual([]);
  });

  test('role kind mismatch is returned without throwing', () => {
    expect(inspectRecipesAgainstCatalog(graph('judge', 'observe-logs'), catalog)).toEqual([
      { nodeId: 'check', recipe: 'observe-logs', problem: 'kind-mismatch' },
    ]);
  });

  test('unknown role is returned without throwing', () => {
    expect(inspectRecipesAgainstCatalog(graph('observe', 'no-such-role'), catalog)).toEqual([
      { nodeId: 'check', recipe: 'no-such-role', problem: 'unknown-role' },
    ]);
  });

  test('each discrepancy is reported in node order without stopping inspection', () => {
    const first = graph('judge', 'observe-logs');
    const second = graph('observe', 'no-such-role');
    const template = { ...first, nodes: [first.nodes[0]!, { ...second.nodes[0]!, nodeId: 'next' }] };
    expect(inspectRecipesAgainstCatalog(template, catalog)).toEqual([
      { nodeId: 'check', recipe: 'observe-logs', problem: 'kind-mismatch' },
      { nodeId: 'next', recipe: 'no-such-role', problem: 'unknown-role' },
    ]);
  });

  test('prefixed runner recipes and none are exempt', () => {
    for (const recipe of ['cmd:run', 'approval:human', 'wf:workflow', 'none']) {
      expect(inspectRecipesAgainstCatalog(graph('gate', recipe), catalog)).toEqual([]);
    }
  });

  test('implement-loop is parseable and legacy recipes remain a visible migration list', () => {
    const source = readFileSync(join(import.meta.dir, '../../graphs/implement-loop.yaml'), 'utf8');
    const parsed = parseGraphTemplateYaml(source, 'implement-loop.yaml');
    expect(parsed.errors).toEqual([]);
    expect(parsed.template).toBeDefined();
    const issues = inspectRecipesAgainstCatalog(parsed.template!, catalog);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues).toContainEqual({ nodeId: 'author', recipe: 'goal-author', problem: 'unknown-role' });
    expect(issues).toContainEqual({ nodeId: 'implement', recipe: 'headless-goal-loop', problem: 'unknown-role' });
  });
});
