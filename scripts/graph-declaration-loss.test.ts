import { describe, expect, test } from 'bun:test';
import { measureGraphDeclarationLoss, renderGraphDeclarationLoss } from './graph-declaration-loss.js';

const graph = (extraNodeKey = '') => `
graph_id: fixture
version: 1
entry_node: start
terminal_nodes: [start]
nodes:
  - node_id: start
    kind: agent
    recipe: implement
    max_visits: 1
    progress: [observed]${extraNodeKey}
edges: []
`;

const overlay = `
overlay_id: fixture-overlay
target: fixture
stage: runtime
applies_when: ready
patch:
  - op: replace
    path: /nodes/0/maxVisits
    value: 2
`;

const options = (files: Record<string, string>) => ({
  graphsDirectory: '/graphs',
  list: (path: string) => path === '/graphs' ? ['fixture.yaml'] : path === '/graphs/overlays' ? ['overlay.yaml'] : [],
  read: (path: string) => files[path]!,
});

describe('graph-declaration-loss', () => {
  test('measures root and overlay YAML files without hardcoded graph counts', () => {
    const measurement = measureGraphDeclarationLoss(options({ '/graphs/fixture.yaml': graph(), '/graphs/overlays/overlay.yaml': overlay }));
    expect(measurement).toMatchObject({ scannedFiles: 2, graphs: 1, nodes: 1, discardedFields: 1, unknownNodeKeys: 0, unreadableFiles: 0 });
    expect(measurement.discardedFieldsByGraph).toEqual({ fixture: 1 });
    expect(measurement.discardedFieldsByField).toEqual({ progress: 1 });
    expect(renderGraphDeclarationLoss(measurement)).toContain('unknown node keys 0');
  });

  test('differentially measures one parser-unknown node key as one unknown key', () => {
    const baseline = measureGraphDeclarationLoss(options({ '/graphs/fixture.yaml': graph(), '/graphs/overlays/overlay.yaml': overlay }));
    const changed = measureGraphDeclarationLoss(options({ '/graphs/fixture.yaml': graph('\n    future_key: observed'), '/graphs/overlays/overlay.yaml': graph() }));
    expect(baseline.unknownNodeKeys).toBe(0);
    expect(changed.unknownNodeKeys).toBe(1);
    expect(changed.unknownNodeKeysByKey).toEqual({ future_key: 1 });
  });

  test('keeps unreadable files distinct from zero loss', () => {
    const measurement = measureGraphDeclarationLoss({
      graphsDirectory: '/graphs',
      list: path => path === '/graphs' ? ['missing.yaml'] : [],
      read: () => { throw new Error('missing'); },
    });
    expect(measurement).toMatchObject({ scannedFiles: 1, graphs: 0, nodes: 0, discardedFields: 0, unknownNodeKeys: 0, unreadableFiles: 1 });
  });
});
