// IMPORT-GRAPH-SCC: report cycles in the static import graph reached by the gate's selected test files.
// The graph comes from the same committed-tree reader as gate-closure. A cycle report is diagnostic;
// opaque or absent inputs remain unmeasured and cannot authorize a smaller gate or concurrent train.
import { isTestPath } from '../../src/self-implement/importer-test-index.js';
import { buildClosureGraph, type ClosureGraph, type ClosureOptions, type ClosureTree } from './gate-closure.js';

export interface ChangedFileImpact {
  readonly file: string;
  /** Definite reverse-dependency reach, including the test file itself. */
  readonly affectedTests: readonly string[];
  readonly affectedTestCount: number;
  /** Tests with an opaque dependency can also be affected; they are never counted as definitely unaffected. */
  readonly possibleTests: readonly string[];
  readonly possibleTestCount: number;
  readonly measured: boolean;
  readonly issues: readonly string[];
}

function changedFileImpacts(graph: ClosureGraph, preload: readonly string[], changedFiles: readonly string[]): ChangedFileImpact[] {
  const tests = [...graph.tracked].filter(isTestPath).sort();
  const reverse = new Map<string, string[]>();
  for (const [from, dependencies] of graph.forward) for (const dependency of dependencies) {
    const importers = reverse.get(dependency) ?? [];
    importers.push(from);
    reverse.set(dependency, importers);
  }
  const reverseReach = (seeds: readonly string[]): Set<string> => {
    const seen = new Set(seeds);
    const queue = [...seeds];
    for (let at = 0; at < queue.length; at++) for (const importer of reverse.get(queue[at]!) ?? []) {
      if (seen.has(importer)) continue;
      seen.add(importer);
      queue.push(importer);
    }
    return seen;
  };
  const uncertainTests = reverseReach([...graph.opaque.keys()]);
  const preloadClosure = new Set<string>();
  const pending = [...preload];
  while (pending.length) {
    const file = pending.pop()!;
    if (preloadClosure.has(file)) continue;
    preloadClosure.add(file);
    pending.push(...(graph.staticImports.get(file) ?? []));
  }
  const preloadOpaque = [...preloadClosure].some((file) => graph.opaque.has(file) || !graph.tracked.has(file));
  return [...new Set(changedFiles)].sort().map((file) => {
    const issues: string[] = [];
    if (!graph.tracked.has(file)) issues.push('changed file missing at HEAD');
    if (preloadOpaque) issues.push('preload closure opaque or missing');
    const reached = preloadClosure.has(file) ? new Set(tests) : reverseReach([file]);
    const affectedTests = tests.filter((test) => reached.has(test));
    const possibleTests = tests.filter((test) => reached.has(test) || uncertainTests.has(test) || preloadOpaque || !graph.tracked.has(file));
    if (possibleTests.length > affectedTests.length) issues.push('unresolved reach may affect more tests');
    return { file, affectedTests, affectedTestCount: affectedTests.length, possibleTests,
      possibleTestCount: possibleTests.length, measured: issues.length === 0, issues };
  });
}

export interface ImportCutCandidate {
  /** Removing these DFS back edges would make this SCC acyclic; the set is deterministic, not minimal. */
  readonly from: string;
  readonly to: string;
  readonly sccSize: number;
  /** Reverse dependency closure of `from` within the selected-test graph, including literal dynamic imports. */
  readonly impactedFiles: readonly string[];
  readonly impactedTests: readonly string[];
}

export interface ImportGraphSccReport {
  readonly scope: 'selected-tests-static-imports';
  readonly measured: boolean;
  readonly selectedTests: readonly string[];
  readonly reachableFiles: number;
  readonly cycleCount: number;
  readonly largestScc: number;
  readonly cutCandidateTotal: number;
  readonly cutCandidates: readonly ImportCutCandidate[];
  readonly opaqueFiles: readonly string[];
  readonly missingTests: readonly string[];
  readonly selectionIssues: readonly string[];
  readonly unmeasuredCount: number;
  readonly changedFileImpacts: readonly ChangedFileImpact[];
}

export interface ImportGraphSelectionStatus {
  /** True only after #28000 reports a complete lookup, with no overflow or unrunnable test. */
  readonly complete: boolean;
  readonly issues: readonly string[];
}

/** Read-only structural report. Call with #28000's exact selected test paths at the same HEAD. */
export function analyzeImportGraphScc(
  tree: ClosureTree,
  selectedTests: readonly string[],
  selectionStatus: ImportGraphSelectionStatus,
  options: ClosureOptions = {},
  changedFiles: readonly string[] = [],
): ImportGraphSccReport {
  const graph = buildClosureGraph(tree, options);
  const changedFileImpactsReport = changedFileImpacts(graph, tree.preload, changedFiles);
  const tests = [...new Set(selectedTests)].sort();
  const missingTests = tests.filter((test) => !graph.staticImports.has(test));
  const reachable = new Set<string>();
  const pending = tests.filter((test) => graph.staticImports.has(test));
  while (pending.length) {
    const file = pending.pop()!;
    if (reachable.has(file)) continue;
    reachable.add(file);
    pending.push(...(graph.staticImports.get(file) ?? []));
  }
  // The SCC is intentionally static, but certainty must follow every dependency the closure reader knows:
  // a dynamic import can reach an opaque file even when that file is outside the static SCC graph.
  const closureReachable = new Set<string>();
  const closurePending = tests.filter((test) => graph.forward.has(test));
  while (closurePending.length) {
    const file = closurePending.pop()!;
    if (closureReachable.has(file)) continue;
    closureReachable.add(file);
    closurePending.push(...(graph.forward.get(file) ?? []));
  }
  const opaqueFiles = [...closureReachable].filter((file) => graph.opaque.has(file)).sort();
  // An empty selection does not prove that no test can observe a change.
  const issues = [...new Set(selectionStatus.issues.length ? selectionStatus.issues
    : selectionStatus.complete ? [] : ['selection incomplete'])].sort();
  const measured = tests.length > 0 && missingTests.length === 0 && opaqueFiles.length === 0 && issues.length === 0;
  const edges = new Map<string, string[]>();
  const reverse = new Map<string, string[]>();
  const impactReverse = new Map<string, string[]>();
  for (const file of closureReachable) for (const next of graph.forward.get(file) ?? []) {
    if (closureReachable.has(next)) impactReverse.set(next, [...(impactReverse.get(next) ?? []), file]);
  }
  for (const file of reachable) {
    const neighbors = [...(graph.staticImports.get(file) ?? []), ...(graph.selfStaticImports.has(file) ? [file] : [])]
      .filter((next) => reachable.has(next)).sort();
    edges.set(file, neighbors);
    for (const next of neighbors) reverse.set(next, [...(reverse.get(next) ?? []), file]);
  }
  for (const importers of reverse.values()) importers.sort();

  // Iterative Kosaraju avoids a JS call-stack limit on a large repository SCC.
  const visited = new Set<string>();
  const order: string[] = [];
  for (const root of [...reachable].sort()) {
    if (visited.has(root)) continue;
    const stack: { file: string; exit: boolean }[] = [{ file: root, exit: false }];
    while (stack.length) {
      const { file, exit } = stack.pop()!;
      if (exit) { order.push(file); continue; }
      if (visited.has(file)) continue;
      visited.add(file);
      stack.push({ file, exit: true });
      for (const next of [...(edges.get(file) ?? [])].reverse()) if (!visited.has(next)) stack.push({ file: next, exit: false });
    }
  }
  const assigned = new Set<string>();
  const components: string[][] = [];
  for (const root of order.reverse()) {
    if (assigned.has(root)) continue;
    const component: string[] = [];
    const stack = [root];
    assigned.add(root);
    while (stack.length) {
      const file = stack.pop()!;
      component.push(file);
      for (const next of reverse.get(file) ?? []) if (!assigned.has(next)) { assigned.add(next); stack.push(next); }
    }
    if (component.length > 1 || graph.selfStaticImports.has(component[0]!)) components.push(component.sort());
  }
  components.sort((a, b) => b.length - a.length || a[0]!.localeCompare(b[0]!));

  const cutEdges: { from: string; to: string; sccSize: number }[] = [];
  for (const component of components) {
    const members = new Set(component);
    const seen = new Set<string>();
    const active = new Set<string>();
    for (const root of component) {
      if (seen.has(root)) continue;
      const stack: { file: string; next: number; neighbors: string[] }[] = [];
      const enter = (file: string): void => {
        seen.add(file);
        active.add(file);
        stack.push({ file, next: 0, neighbors: (edges.get(file) ?? []).filter((next) => members.has(next)) });
      };
      enter(root);
      while (stack.length) {
        const frame = stack[stack.length - 1]!;
        const next = frame.neighbors[frame.next++];
        if (next === undefined) { active.delete(frame.file); stack.pop(); continue; }
        if (active.has(next)) cutEdges.push({ from: frame.file, to: next, sccSize: component.length });
        else if (!seen.has(next)) enter(next);
      }
    }
  }
  const testSet = new Set(tests);
  const cutCandidates = cutEdges.slice(0, 10).map(({ from, to, sccSize }) => {
    const impact = new Set<string>();
    const stack = [from];
    while (stack.length) {
      const file = stack.pop()!;
      if (impact.has(file)) continue;
      impact.add(file);
      stack.push(...(impactReverse.get(file) ?? []));
    }
    const impactedFiles = [...impact].sort();
    return { from, to, sccSize, impactedFiles, impactedTests: impactedFiles.filter((file) => testSet.has(file)) };
  });
  return {
    scope: 'selected-tests-static-imports', measured, selectedTests: tests,
    reachableFiles: reachable.size, cycleCount: components.length, largestScc: components[0]?.length ?? 0,
    cutCandidateTotal: cutEdges.length, cutCandidates, opaqueFiles, missingTests,
    selectionIssues: issues, unmeasuredCount: opaqueFiles.length + missingTests.length + issues.length + (tests.length === 0 ? 1 : 0),
    changedFileImpacts: changedFileImpactsReport,
  };
}
