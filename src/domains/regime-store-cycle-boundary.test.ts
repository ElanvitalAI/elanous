import { RUNTIME_SCC_BOUNDARY_ROOTS, runtimeSccBoundaryGraph } from '../../test/helpers/runtime-scc-boundary-graph.js';
import { expect, test } from 'bun:test';
import { REGIME_DB_PATH as PUBLIC_REGIME_DB_PATH } from './regime-store.js';
import { REGIME_DB_PATH as LEAF_REGIME_DB_PATH } from './regime-db-path.js';

test('regime stores and fetchers are not in one runtime SCC', () => {
  const graph = runtimeSccBoundaryGraph();
  const members = ['src/domains/macro-store.ts', 'src/domains/regime-fetchers.ts', 'src/domains/regime-store.ts'];
  for (const member of members) expect(RUNTIME_SCC_BOUNDARY_ROOTS.has(member), `${member} is a graph root`).toBe(true);
  for (const member of members) expect(graph.tracked.has(member), member).toBe(true);
  const reachableFrom = (start: string): Set<string> => {
    const visited = new Set<string>([start]);
    const queue = [start];
    while (queue.length > 0) {
      for (const dependency of graph.staticImports.get(queue.pop()!) ?? []) {
        if (!visited.has(dependency)) {
          visited.add(dependency);
          queue.push(dependency);
        }
      }
    }
    return visited;
  };
  const reverse = new Map<string, string[]>();
  for (const [from, dependencies] of graph.staticImports) {
    for (const dependency of dependencies) reverse.set(dependency, [...(reverse.get(dependency) ?? []), from]);
  }
  const canReach = (target: string): Set<string> => {
    const visited = new Set<string>([target]);
    const queue = [target];
    while (queue.length > 0) {
      for (const importer of reverse.get(queue.pop()!) ?? []) {
        if (!visited.has(importer)) {
          visited.add(importer);
          queue.push(importer);
        }
      }
    }
    return visited;
  };
  for (const member of members) {
    const forward = reachableFrom(member);
    const incoming = canReach(member);
    const cycleMembers = [...forward].filter((candidate) => candidate !== member && incoming.has(candidate));
    expect(cycleMembers, `${member} belongs to a non-trivial SCC`).toEqual([]);
  }
  expect(PUBLIC_REGIME_DB_PATH).toBe(LEAF_REGIME_DB_PATH);
});
