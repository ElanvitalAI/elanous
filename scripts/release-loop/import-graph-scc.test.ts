import { describe, expect, test } from 'bun:test';
import { analyzeImportGraphScc } from './import-graph-scc.js';
import type { ClosureTree } from './gate-closure.js';

function fixture(contents: Record<string, string>): ClosureTree {
  return { files: Object.keys(contents), read: (file) => contents[file], preload: [] };
}

describe('IMPORT-GRAPH-SCC selected import graph report', () => {
  test('selected tests reach one cycle; a cut candidate reports its reverse impact closure', () => {
    const tree = fixture({
      'test/a.test.ts': "import '../src/a.js';",
      'test/b.test.ts': "import '../src/b.js';",
      'test/dynamic.test.ts': "import('../src/a.js');",
      'test/unrelated.test.ts': "import '../src/free.js';",
      'src/a.ts': "import './b.js';",
      'src/b.ts': "import './c.js';",
      'src/c.ts': "import './a.js';",
      'src/free.ts': 'export const free = 1;',
    });
    const report = analyzeImportGraphScc(tree, ['test/b.test.ts', 'test/a.test.ts', 'test/dynamic.test.ts'], { complete: true, issues: [] });
    expect(report.measured).toBe(true);
    expect(report.selectedTests).toEqual(['test/a.test.ts', 'test/b.test.ts', 'test/dynamic.test.ts']);
    expect(report.cycleCount).toBe(1);
    expect(report.largestScc).toBe(3);
    expect(report.cutCandidateTotal).toBe(1);
    expect(report.cutCandidates).toHaveLength(1);
    expect(report.cutCandidates[0]).toMatchObject({ from: 'src/c.ts', to: 'src/a.ts' });
    expect(report.cutCandidates[0]!.impactedTests).toEqual(['test/a.test.ts', 'test/b.test.ts', 'test/dynamic.test.ts']);
    expect(report.cutCandidates[0]!.impactedFiles).not.toContain('test/unrelated.test.ts');
    expect(report.opaqueFiles).toEqual([]);
    const cut = fixture({
      'test/a.test.ts': "import '../src/a.js';", 'test/b.test.ts': "import '../src/b.js';",
      'src/a.ts': "import './b.js';", 'src/b.ts': "import './c.js';", 'src/c.ts': 'export const end = 1;',
    });
    expect(analyzeImportGraphScc(cut, ['test/a.test.ts', 'test/b.test.ts'], { complete: true, issues: [] }).cycleCount).toBe(0);
  });

  test('unreadable or opaque selected path stays unmeasured while preserving cycle observations', () => {
    const tree = fixture({
      'test/a.test.ts': "import '../src/a.js';",
      'src/a.ts': "import './b.js';",
      'src/b.ts': "import './a.js'; import(variable);",
    });
    const report = analyzeImportGraphScc(tree, ['test/a.test.ts', 'test/missing.test.ts'], { complete: true, issues: [] });
    expect(report.measured).toBe(false);
    expect(report.missingTests).toEqual(['test/missing.test.ts']);
    expect(report.opaqueFiles).toEqual(['src/b.ts']);
    expect(report.unmeasuredCount).toBe(2);
    expect(report.cycleCount).toBe(1);
    expect(analyzeImportGraphScc(tree, [], { complete: true, issues: [] }).measured).toBe(false);
    const incompleteSelection = analyzeImportGraphScc(tree, ['test/a.test.ts'], { complete: false, issues: ['importer lookup failed'] });
    expect(incompleteSelection.measured).toBe(false);
    expect(incompleteSelection.selectionIssues).toEqual(['importer lookup failed']);
    expect(analyzeImportGraphScc(tree, ['test/a.test.ts'], { complete: false, issues: [] }).selectionIssues).toEqual(['selection incomplete']);
  });

  test('a static self-import is a one-file cycle with an explicit cut candidate', () => {
    const tree = fixture({
      'test/self.test.ts': "import '../src/self.js';",
      'src/self.ts': "import './self.js'; export const value = 1;",
    });
    const report = analyzeImportGraphScc(tree, ['test/self.test.ts'], { complete: true, issues: [] });
    expect(report.measured).toBe(true);
    expect(report.cycleCount).toBe(1);
    expect(report.largestScc).toBe(1);
    expect(report.cutCandidates[0]).toMatchObject({
      from: 'src/self.ts', to: 'src/self.ts', impactedTests: ['test/self.test.ts'],
    });
  });

  test('a dynamic dependency outside the static SCC still makes opacity unmeasured', () => {
    const tree = fixture({
      'test/dynamic.test.ts': "import('../src/entry.js');",
      'src/entry.ts': 'import(variable);',
    });
    const report = analyzeImportGraphScc(tree, ['test/dynamic.test.ts'], { complete: true, issues: [] });
    expect(report.cycleCount).toBe(0);
    expect(report.measured).toBe(false);
    expect(report.opaqueFiles).toEqual(['src/entry.ts']);
    expect(report.unmeasuredCount).toBe(1);
  });

  test('changed files report definite and possible tests through reverse BFS', () => {
    const tree = fixture({
      'test/direct.test.ts': "import '../src/entry.js';",
      'test/dynamic.test.ts': "import('../src/entry.js');",
      'test/opaque.test.ts': "import '../src/opaque.js';",
      'test/free.test.ts': "import '../src/free.js';",
      'src/entry.ts': "import './leaf.js';",
      'src/leaf.ts': 'export const leaf = 1;',
      'src/opaque.ts': 'import(variable);',
      'src/free.ts': 'export const free = 1;',
    });
    const report = analyzeImportGraphScc(tree, ['test/direct.test.ts'], { complete: true, issues: [] }, {},
      ['src/leaf.ts', 'src/free.ts', 'src/leaf.ts']);
    expect(report.changedFileImpacts.map((item) => item.file)).toEqual(['src/free.ts', 'src/leaf.ts']);
    expect(report.changedFileImpacts[1]).toMatchObject({
      affectedTests: ['test/direct.test.ts', 'test/dynamic.test.ts'], affectedTestCount: 2,
      possibleTests: ['test/direct.test.ts', 'test/dynamic.test.ts', 'test/opaque.test.ts'],
      possibleTestCount: 3, measured: false,
    });
    expect(report.changedFileImpacts[0]).toMatchObject({
      affectedTests: ['test/free.test.ts'], affectedTestCount: 1, possibleTestCount: 2, measured: false,
    });
  });

  test('changed preload affects every test and missing changed paths remain unmeasured', () => {
    const baseTree = fixture({
      'test/a.test.ts': 'test("a", () => {});',
      'test/b.test.ts': 'test("b", () => {});',
      'test/preload.ts': "import '../src/shared.js';",
      'src/shared.ts': 'export const value = 1;',
    });
    const tree = { ...baseTree, preload: ['test/preload.ts'] };
    const report = analyzeImportGraphScc(tree, ['test/a.test.ts'], { complete: true, issues: [] }, {},
      ['src/shared.ts', 'src/deleted.ts']);
    expect(report.changedFileImpacts[1]).toMatchObject({ affectedTestCount: 2, possibleTestCount: 2, measured: true });
    expect(report.changedFileImpacts[0]).toMatchObject({ measured: false, possibleTestCount: 2,
      issues: ['changed file missing at HEAD', 'unresolved reach may affect more tests'] });
  });
});
