import { RUNTIME_SCC_BOUNDARY_ROOTS, runtimeSccBoundaryGraph } from '../../test/helpers/runtime-scc-boundary-graph.js';
import { expect, test } from 'bun:test';

test('machine name and profile are not in the same runtime import SCC', () => {
  const graph = runtimeSccBoundaryGraph();
  const reaches = (from: string, to: string): boolean => {
    const visited = new Set([from]);
    const queue = [from];
    while (queue.length > 0) {
      for (const dependency of graph.staticImports.get(queue.pop()!) ?? []) {
        if (dependency === to) return true;
        if (!visited.has(dependency)) {
          visited.add(dependency);
          queue.push(dependency);
        }
      }
    }
    return false;
  };

  const machineName = 'src/roles/machine-name.ts';
  const machineProfile = 'src/roles/machine-profile.ts';
  for (const member of [machineName, machineProfile]) expect(RUNTIME_SCC_BOUNDARY_ROOTS.has(member), `${member} is a graph root`).toBe(true);
  expect(reaches(machineName, machineProfile)).toBe(true);
  expect(reaches(machineProfile, machineName)).toBe(false);
});
