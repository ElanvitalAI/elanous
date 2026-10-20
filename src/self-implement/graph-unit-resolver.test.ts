import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveGraphUnit } from './graph-unit-resolver.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('a malformed nearer unit with the requested id blocks a valid lower-priority copy', () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-unit-resolver-priority-'));
  roots.push(root);
  mkdirSync(join(root, 'units'));
  writeFileSync(join(root, 'units', 'unit.yaml'), `graph_id: shared
version: 1
unit: { inputs: invalid, outputs: [], exits: [done] }
entry_node: work
terminal_nodes: [done]
nodes:
  - { node_id: work, kind: agent, recipe: work, max_visits: 1 }
  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }
edges:
  - { from: work, to: done }
`);
  writeFileSync(join(root, 'unit.yaml'), `graph_id: shared
version: 1
unit: { inputs: [], outputs: [], exits: [done] }
entry_node: work
terminal_nodes: [done]
nodes:
  - { node_id: work, kind: agent, recipe: work, max_visits: 1 }
  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }
edges:
  - { from: work, to: done }
`);
  expect(() => resolveGraphUnit('shared@1', join(root, 'root.yaml'))).toThrow('invalid graph unit: shared@1');
});

test('an explicit malformed unit with a missing version still blocks a lower-priority copy', () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-unit-resolver-missing-version-'));
  roots.push(root);
  mkdirSync(join(root, 'units'));
  writeFileSync(join(root, 'units', 'unit.yaml'), `graph_id: shared\nunit: { inputs: [], outputs: [], exits: [done] }\n`);
  writeFileSync(join(root, 'unit.yaml'), `graph_id: shared\nversion: 1\nunit: { inputs: [], outputs: [], exits: [done] }\nentry_node: work\nterminal_nodes: [done]\nnodes:\n  - { node_id: work, kind: agent, recipe: work, max_visits: 1 }\n  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }\nedges:\n  - { from: work, to: done }\n`);
  expect(() => resolveGraphUnit('shared@1', join(root, 'root.yaml'))).toThrow('invalid graph unit: shared@1');
});

test('a YAML parse failure with an explicit unit header still blocks a lower-priority copy', () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-unit-resolver-invalid-yaml-'));
  roots.push(root);
  mkdirSync(join(root, 'units'));
  writeFileSync(join(root, 'units', 'unit.yaml'), `graph_id: shared\nversion: 1\nunit: { inputs: [], outputs: [], exits: [done]\n`);
  writeFileSync(join(root, 'unit.yaml'), `graph_id: shared\nversion: 1\nunit: { inputs: [], outputs: [], exits: [done] }\nentry_node: work\nterminal_nodes: [done]\nnodes:\n  - { node_id: work, kind: agent, recipe: work, max_visits: 1 }\n  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }\nedges:\n  - { from: work, to: done }\n`);
  expect(() => resolveGraphUnit('shared@1', join(root, 'root.yaml'))).toThrow('invalid graph unit: shared@1');
});

test('a valid nearer non-unit graph with the requested id is skipped for the lower-priority unit', () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-unit-resolver-non-unit-'));
  roots.push(root);
  mkdirSync(join(root, 'units'));
  writeFileSync(join(root, 'units', 'graph.yaml'), `graph_id: shared
version: 1
entry_node: work
terminal_nodes: [done]
nodes:
  - { node_id: work, kind: agent, recipe: work, max_visits: 1 }
  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }
edges:
  - { from: work, to: done }
`);
  const unitPath = join(root, 'unit.yaml');
  writeFileSync(unitPath, `graph_id: shared
version: 1
unit: { inputs: [], outputs: [], exits: [done] }
entry_node: work
terminal_nodes: [done]
nodes:
  - { node_id: work, kind: agent, recipe: work, max_visits: 1 }
  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }
edges:
  - { from: work, to: done }
`);
  expect(resolveGraphUnit('shared@1', join(root, 'root.yaml')).path).toBe(unitPath);
});
