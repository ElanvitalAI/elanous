import { RUNTIME_SCC_BOUNDARY_ROOTS, runtimeSccBoundaryGraph } from '../../test/helpers/runtime-scc-boundary-graph.js';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, test } from 'bun:test';

test('code-edit and plan-mode boundary modules are not in one runtime SCC', () => {
  const graph = runtimeSccBoundaryGraph();
  const members = [
    'src/code-edit/apply.ts', 'src/code-edit/index.ts', 'src/code-edit/tools.ts',
    'src/plan-mode/index.ts', 'src/plan-mode/tool-enter.ts', 'src/plan-mode/tool-exit.ts',
  ];
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
  const reachability = new Map(members.map((member) => [member, reachableFrom(member)]));
  for (let i = 0; i < members.length; i++) for (let j = i + 1; j < members.length; j++) {
    const a = members[i]!;
    const b = members[j]!;
    expect(reachability.get(a)!.has(b) && reachability.get(b)!.has(a), `${a} ↔ ${b}`).toBe(false);
  }

  for (const [path, requiredReexports] of [
    ['src/code-edit/index.ts', ['./apply.js', './tools.js']],
    ['src/plan-mode/index.ts', ['./tool-enter.js', './tool-exit.js']],
  ] as const) {
    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
    expect(source.statements.every(ts.isExportDeclaration), `${path} remains a side-effect-free barrel`).toBe(true);
    const reexports = source.statements.flatMap((statement) => ts.isExportDeclaration(statement)
      && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
      ? [statement.moduleSpecifier.text]
      : []);
    for (const target of requiredReexports) expect(reexports, `${path} re-exports ${target}`).toContain(target);
  }
});
