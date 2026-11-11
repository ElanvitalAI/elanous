#!/usr/bin/env bun
/** Compare the gate runtime's eager import closure and definite test radius at two committed heads. */
import { isTestPath } from '../../src/self-implement/importer-test-index.js';
import { buildClosureGraph, gitClosureTree, type ClosureGraph } from './gate-closure.js';

const ROOT = 'scripts/release-loop/gate-runtime.ts';
const TARGETS = [
  'src/control-plane/server.ts',
  'scripts/release-loop/gate-train-file-cas.ts',
  'scripts/release-loop/gate-warm-artifacts.ts',
] as const;

function reach(seed: string, edges: ClosureGraph['forward']): Set<string> {
  const seen = new Set<string>();
  const queue = [seed];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    queue.push(...(edges.get(file) ?? []));
  }
  return seen;
}

function measure(repo: string, commit: string) {
  const tree = gitClosureTree(repo, commit);
  const graph = buildClosureGraph(tree, {
    omitFunctionLocalRequires: true,
    omitFunctionLocalProcessSpawnOpacity: true,
    shadowCandidatePrecision: true,
  });
  const tests = tree.files.filter(isTestPath);
  const reverse = new Map<string, string[]>();
  for (const [from, dependencies] of graph.forward) for (const dependency of dependencies) {
    reverse.set(dependency, [...(reverse.get(dependency) ?? []), from]);
  }
  const definiteTests = (target: string) => [...reach(target, reverse)].filter(isTestPath).length;
  return {
    commit,
    totalTests: tests.length,
    gateRuntimeStaticFiles: reach(ROOT, graph.staticImports).size,
    edges: TARGETS.map((target) => ({
      target,
      eager: graph.staticImports.get(ROOT)?.includes(target) ?? false,
      targetStaticFiles: reach(target, graph.staticImports).size,
      definiteTestRadius: definiteTests(target),
    })),
  };
}

if (import.meta.main) {
  const [before, after] = process.argv.slice(2);
  if (!before || !after) throw new Error('Usage: bun gate-lazy-require-measure.ts <before-sha> <after-sha>');
  console.log(JSON.stringify({ before: measure(process.cwd(), before), after: measure(process.cwd(), after) }, null, 2));
}
