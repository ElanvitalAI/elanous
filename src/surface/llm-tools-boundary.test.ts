import { RUNTIME_SCC_BOUNDARY_ROOTS, runtimeSccBoundaryGraph } from '../../test/helpers/runtime-scc-boundary-graph.js';
import { describe, expect, test } from 'bun:test';
import * as publicSurface from './index.js';
import * as llmTools from './llm-tools.js';

describe('surface LLM tools import boundary', () => {
  test('the current runtime import graph keeps the barrel and tools out of one non-trivial SCC', () => {
    const graph = runtimeSccBoundaryGraph();
    const members = ['src/surface/index.ts', 'src/surface/llm-tools.ts'];
    for (const member of members) expect(RUNTIME_SCC_BOUNDARY_ROOTS.has(member), `${member} is a graph root`).toBe(true);
    for (const member of members) expect(graph.tracked.has(member), member).toBe(true);
    const reverse = new Map<string, string[]>();
    for (const [from, dependencies] of graph.staticImports) {
      for (const dependency of dependencies) reverse.set(dependency, [...(reverse.get(dependency) ?? []), from]);
    }
    for (const member of members) {
      const forward = new Set<string>([member]);
      const queue = [member];
      while (queue.length > 0) {
        for (const dependency of graph.staticImports.get(queue.pop()!) ?? []) {
          if (!forward.has(dependency)) { forward.add(dependency); queue.push(dependency); }
        }
      }
      const incoming = new Set<string>([member]);
      const reverseQueue = [member];
      while (reverseQueue.length > 0) {
        for (const importer of reverse.get(reverseQueue.pop()!) ?? []) {
          if (!incoming.has(importer)) { incoming.add(importer); reverseQueue.push(importer); }
        }
      }
      const cycleMembers = [...forward].filter((candidate) => candidate !== member && incoming.has(candidate));
      expect(cycleMembers, `${member} belongs to a non-trivial SCC`).toEqual([]);
    }
  });

  test('the public barrel continues to expose the LLM tool functions', () => {
    expect(publicSurface.buildGetUIStateTool).toBe(llmTools.buildGetUIStateTool);
    expect(publicSurface.dispatchGetUIState).toBe(llmTools.dispatchGetUIState);
    expect(publicSurface.dispatchDescribeSurface).toBe(llmTools.dispatchDescribeSurface);
    expect(publicSurface.dispatchObserveSurface).toBe(llmTools.dispatchObserveSurface);
  });
});
