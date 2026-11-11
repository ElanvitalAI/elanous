import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClosureTree } from '../../scripts/release-loop/gate-closure.js';
import { renderTestCensus } from '../../scripts/test-census.js';
import { simulateDeleteImpact } from './delete-impact-sim.js';

const NOW = 40 * 24 * 60 * 60 * 1000;

function fakeWorld() {
  const root = mkdtempSync(join(tmpdir(), 'delete-impact-world-'));
  const gateDir = join(root, 'gate');
  mkdirSync(join(root, 'src'));
  mkdirSync(gateDir);
  writeFileSync(join(gateDir, 'shards.json'), JSON.stringify({ shards: [{ state: 'done' }] }));
  writeFileSync(join(root, 'src/feature.test.ts'), "test('feature call', () => expect(true).toBe(true));\n");
  writeFileSync(join(gateDir, 'cases.junit.xml'), '<testsuite><testcase file="src/feature.test.ts" name="feature call" classname="" time="0"/></testsuite>');
  const censusJson = renderTestCensus([gateDir, '--source-root', root, '--format', 'json']);
  const contents = new Map<string, string>([
    ['src/feature.ts', 'export const feature = true;\n'],
    ['src/feature.test.ts', "import { feature } from './feature.js'; test('feature call', () => expect(feature).toBe(true));\n"],
    ['src/cli/feature-cli.ts', "import { feature } from '../feature.js'; export const command = feature;\n"],
    ['src/dynamic.ts', "export const load = () => import('./feature.js');\n"],
    ['src/tui/menu.ts', 'export const menu = ["feature-mode"];\n'],
    ['src/config/feature.ts', 'export const featureKey = "feature-mode";\n'],
    ['graphs/work/feature.yaml', 'node: src/feature.ts\n'],
    ['scenarios/ux-sim/feature.yaml', 'id: feature\nsource: src/feature.ts\n'],
    ['scenarios/ux-sim/indirect.yaml', 'id: indirect\nsource: src/cli/feature-cli.ts\n'],
  ]);
  const tree: ClosureTree = { files: [...contents.keys()], read: path => contents.get(path), preload: [] };
  return { root, tree, censusJson, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

test('virtual deletion selects only affected census tests and scenario, then reports every remaining surface and a recent call', async () => {
  const world = fakeWorld();
  try {
    let selected: string[] = [];
    const receipt = await simulateDeleteImpact({ tree: world.tree, removePaths: ['src/feature.ts'],
      callKeys: ['feature-mode'], callKeyInventoryComplete: true, censusJson: world.censusJson, nowMs: NOW,
      logWindow: { fromMs: 0, toMs: NOW, complete: true, calls: [{ atMs: NOW - 1000, key: 'feature-mode' }] },
      execute: async ({ tests, scenarios, virtualTree }) => {
        selected = [...tests, ...scenarios];
        expect(virtualTree.files).not.toContain('src/feature.ts');
        expect(virtualTree.read('src/feature.ts')).toBeUndefined();
        return { passed: false, receiptRefs: ['sim:test-failed'] };
      },
      typecheck: async (affectedPaths, virtualTree) => {
        expect(affectedPaths).toContain('src/feature.ts');
        expect(affectedPaths).toContain('src/cli/feature-cli.ts');
        expect(virtualTree.files).not.toContain('src/feature.ts');
        return { passed: false, receiptRef: 'sim:tsc-failed' };
      } });
    expect(selected).toEqual(['src/feature.test.ts', 'scenarios/ux-sim/feature.yaml', 'scenarios/ux-sim/indirect.yaml']);
    expect(receipt).toMatchObject({ universe: 'simulation', decision: 'delete-risk',
      selectedTests: ['src/feature.test.ts'], selectedScenarios: ['scenarios/ux-sim/feature.yaml', 'scenarios/ux-sim/indirect.yaml'], logCalls30d: 1,
      censusMissing: [] });
    expect(receipt.remainingImporters).toContain('src/cli/feature-cli.ts');
    expect(receipt.remainingImporters).toContain('src/dynamic.ts');
    expect(receipt.virtualOpaque).toContain('src/dynamic.ts');
    expect(receipt.checkedCallKeys).toContain('feature-mode');
    expect(receipt.logCoverage).toEqual({ fromMs: 0, toMs: NOW, complete: true });
    expect(receipt.checkedLogInterval).toEqual({ fromMs: NOW - 30 * 24 * 60 * 60 * 1000, toMs: NOW }); // Source: 30-day filter interval in the receipt contract.
    expect(receipt.matchedCalls30d).toEqual([{ atMs: NOW - 1000, key: 'feature-mode' }]);
    expect(receipt.surfaces.map(row => row.kind)).toContain('graph');
    expect(receipt.surfaces.map(row => row.kind)).toContain('slash-menu');
    expect(receipt.surfaces.map(row => row.kind)).toContain('config');
  } finally { world.dispose(); }
});

test('an unused module is safe only with measured empty calls, passing selection and typecheck receipts', async () => {
  const world = fakeWorld();
  try {
    writeFileSync(join(world.root, 'src/other.test.ts'), "test('other', () => expect(true).toBe(true));\n");
    const unusedGate = join(world.root, 'gate-unused');
    mkdirSync(unusedGate);
    writeFileSync(join(unusedGate, 'shards.json'), JSON.stringify({ shards: [{ state: 'done' }] }));
    writeFileSync(join(unusedGate, 'cases.junit.xml'), '<testsuite><testcase file="src/other.test.ts" name="other" classname="" time="0"/></testsuite>');
    const unusedCensusJson = renderTestCensus([unusedGate, '--source-root', world.root, '--format', 'json']);
    const tree: ClosureTree = { files: ['src/unused.ts', 'src/other.test.ts'],
      read: path => path === 'src/unused.ts' ? 'export const unused = true;\n' : "test('other', () => expect(true).toBe(true));\n",
      preload: [] };
    const common = { tree, removePaths: ['src/unused.ts'], callKeys: ['unused-feature'], callKeyInventoryComplete: true,
      censusJson: unusedCensusJson, scenarioInventory: { paths: [], complete: true, sourceRef: 'sim:scenario-manifest' },
      nowMs: NOW, execute: async () => ({ passed: true, receiptRefs: ['sim:no-affected-tests'] }),
      typecheck: async () => ({ passed: true, receiptRef: 'sim:tsc-pass' }) };
    const measured = await simulateDeleteImpact({ ...common,
      logWindow: { fromMs: 0, toMs: NOW, complete: true, calls: [] } });
    expect(measured).toMatchObject({ decision: 'delete-safe', selectedTests: [], selectedScenarios: [], logCalls30d: 0, reasons: [] });
    const missingTestTree: ClosureTree = { ...tree, files: [...tree.files, 'src/unrelated.test.ts'],
      read: path => path === 'src/unrelated.test.ts' ? "test('unrelated', () => {});\n" : tree.read(path) };
    const missingTest = await simulateDeleteImpact({ ...common, tree: missingTestTree,
      logWindow: { fromMs: 0, toMs: NOW, complete: true, calls: [] } });
    expect(missingTest).toMatchObject({ decision: 'delete-risk', censusMissing: ['src/unrelated.test.ts'] });
    const partialCaseTree: ClosureTree = { ...tree,
      read: path => path === 'src/other.test.ts'
        ? "test('other', () => {}); test('omitted case', () => {});\n" : tree.read(path) };
    const partialCase = await simulateDeleteImpact({ ...common, tree: partialCaseTree,
      logWindow: { fromMs: 0, toMs: NOW, complete: true, calls: [] } });
    expect(partialCase).toMatchObject({ decision: 'delete-risk', censusCasesMissing: ['src/other.test.ts'] });
    for (const source of ["test.only('other', () => {});\n", "test('different', () => {});\n"]) {
      const alteredCaseTree: ClosureTree = { ...tree,
        read: path => path === 'src/other.test.ts' ? source : tree.read(path) };
      const alteredCase = await simulateDeleteImpact({ ...common, tree: alteredCaseTree,
        logWindow: { fromMs: 0, toMs: NOW, complete: true, calls: [] } });
      expect(alteredCase.censusCasesMissing).toContain('src/other.test.ts');
    }
    const aliasCaseTree: ClosureTree = { ...tree,
      read: path => path === 'src/other.test.ts'
        ? "import { test as check } from 'bun:test'; test('other', () => {}); check('omitted', () => {});\n"
        : tree.read(path) };
    const aliasCase = await simulateDeleteImpact({ ...common, tree: aliasCaseTree,
      logWindow: { fromMs: 0, toMs: NOW, complete: true, calls: [] } });
    expect(aliasCase.censusCasesMissing).toContain('src/other.test.ts');
    const alternateTestTree: ClosureTree = { ...tree, files: [...tree.files, 'src/feature_test.ts'],
      read: path => path === 'src/feature_test.ts' ? "test('alternate', () => {});\n" : tree.read(path) };
    const alternateTest = await simulateDeleteImpact({ ...common, tree: alternateTestTree,
      logWindow: { fromMs: 0, toMs: NOW, complete: true, calls: [] } });
    expect(alternateTest).toMatchObject({ decision: 'delete-risk', censusMissing: ['src/feature_test.ts'] });
    const indirectScenarioTree: ClosureTree = { ...tree, files: [...tree.files, 'plugins/other/sims/indirect.yaml'],
      read: path => path === 'plugins/other/sims/indirect.yaml' ? 'id: unrelated-alias\n' : tree.read(path) };
    const indirectScenario = await simulateDeleteImpact({ ...common, tree: indirectScenarioTree,
      logWindow: { fromMs: 0, toMs: NOW, complete: true, calls: [] } });
    expect(indirectScenario).toMatchObject({ decision: 'delete-risk', unverifiedScenarios: ['plugins/other/sims/indirect.yaml'] });
    const missingInventory = await simulateDeleteImpact({ ...common, scenarioInventory: undefined,
      logWindow: { fromMs: 0, toMs: NOW, complete: true, calls: [] } });
    expect(missingInventory.reasons).toContain('scenario inventory coverage unmeasured');
    const externalScenarioTree: ClosureTree = { ...tree, files: [...tree.files, 'catalog/hidden-case.toml'],
      read: path => path === 'catalog/hidden-case.toml' ? 'source = "indirect-alias"\n' : tree.read(path) };
    const externalScenario = await simulateDeleteImpact({ ...common, tree: externalScenarioTree,
      scenarioInventory: { paths: ['catalog/hidden-case.toml'], complete: true, sourceRef: 'sim:external-manifest' },
      logWindow: { fromMs: 0, toMs: NOW, complete: true, calls: [] } });
    expect(externalScenario).toMatchObject({ decision: 'delete-risk', unverifiedScenarios: ['catalog/hidden-case.toml'] });
    const unrelatedScenario = await simulateDeleteImpact({ ...common, tree: externalScenarioTree,
      scenarioInventory: { paths: ['catalog/hidden-case.toml'], dependencies: { 'catalog/hidden-case.toml': [] },
        complete: true, sourceRef: 'sim:external-manifest' },
      logWindow: { fromMs: 0, toMs: NOW, complete: true, calls: [] } });
    expect(unrelatedScenario).toMatchObject({ decision: 'delete-safe', unverifiedScenarios: [] });
    const chainedScenarioTree: ClosureTree = { ...tree,
      files: [...tree.files, 'scenarios/ux-sim/b.yaml', 'scenarios/ux-sim/a.yaml'],
      read: path => path === 'scenarios/ux-sim/b.yaml' ? 'id: b\n'
        : path === 'scenarios/ux-sim/a.yaml' ? 'id: a\n' : tree.read(path) };
    const chainedScenario = await simulateDeleteImpact({ ...common, tree: chainedScenarioTree,
      scenarioInventory: { paths: ['scenarios/ux-sim/a.yaml', 'scenarios/ux-sim/b.yaml'], complete: true,
        sourceRef: 'sim:linked-manifest', dependencies: {
          'scenarios/ux-sim/b.yaml': ['src/unused.ts'],
          'scenarios/ux-sim/a.yaml': ['scenarios/ux-sim/b.yaml'],
        } },
      logWindow: { fromMs: 0, toMs: NOW, complete: true, calls: [] } });
    expect(chainedScenario).toMatchObject({ decision: 'delete-safe', selectedScenarios: ['scenarios/ux-sim/a.yaml', 'scenarios/ux-sim/b.yaml'] });
    const referencedScenarioTree: ClosureTree = { ...chainedScenarioTree,
      read: path => path === 'scenarios/ux-sim/b.yaml' ? 'source: src/unused.ts\n' : chainedScenarioTree.read(path) };
    const referencedScenario = await simulateDeleteImpact({ ...common, tree: referencedScenarioTree,
      scenarioInventory: { paths: ['scenarios/ux-sim/a.yaml', 'scenarios/ux-sim/b.yaml'], complete: true,
        sourceRef: 'sim:linked-manifest', dependencies: {
          'scenarios/ux-sim/b.yaml': [], 'scenarios/ux-sim/a.yaml': ['scenarios/ux-sim/b.yaml'],
        } },
      logWindow: { fromMs: 0, toMs: NOW, complete: true, calls: [] } });
    expect(referencedScenario.selectedScenarios).toEqual(['scenarios/ux-sim/a.yaml', 'scenarios/ux-sim/b.yaml']);
    const deletedScenarioTree: ClosureTree = { ...tree, files: [...tree.files, 'scenarios/ux-sim/retired.yaml'],
      read: path => path === 'scenarios/ux-sim/retired.yaml' ? 'id: retired\n' : tree.read(path) };
    const deletedScenario = await simulateDeleteImpact({ ...common, tree: deletedScenarioTree,
      removePaths: ['src/unused.ts', 'scenarios/ux-sim/retired.yaml'],
      scenarioInventory: { paths: ['scenarios/ux-sim/retired.yaml'], complete: true,
        sourceRef: 'sim:retired-manifest', dependencies: { 'scenarios/ux-sim/retired.yaml': [] } },
      logWindow: { fromMs: 0, toMs: NOW, complete: true, calls: [] } });
    expect(deletedScenario).toMatchObject({ decision: 'delete-safe', unverifiedScenarios: [] });
    const unreadableTomlTree: ClosureTree = { ...tree, files: [...tree.files, 'config/prod.toml'],
      read: path => path === 'config/prod.toml' ? undefined : tree.read(path) };
    const unreadableToml = await simulateDeleteImpact({ ...common, tree: unreadableTomlTree,
      logWindow: { fromMs: 0, toMs: NOW, complete: true, calls: [] } });
    expect(unreadableToml.unreadablePaths).toContain('config/prod.toml');
    const blankReceipts = await simulateDeleteImpact({ ...common,
      execute: async () => ({ passed: true, receiptRefs: [''] }),
      typecheck: async () => ({ passed: true, receiptRef: ' ' }),
      logWindow: { fromMs: 0, toMs: NOW, complete: true, calls: [] } });
    expect(blankReceipts.decision).toBe('delete-risk');
    const invalidLog = await simulateDeleteImpact({ ...common,
      logWindow: { fromMs: -Infinity, toMs: NOW, complete: true, calls: [{ atMs: NaN, key: 'unused-feature' }] } });
    expect(invalidLog).toMatchObject({ decision: 'delete-risk', logCalls30d: null });
    const unmeasured = await simulateDeleteImpact({ ...common,
      logWindow: { fromMs: NOW - 1000, toMs: NOW, complete: false, calls: [] } });
    expect(unmeasured.decision).toBe('delete-risk');
    expect(unmeasured.reasons).toContain('30-day call log coverage unmeasured');
    const unreadableTree: ClosureTree = { ...tree, files: [...tree.files, 'graphs/work/unknown.yaml'],
      read: path => path === 'graphs/work/unknown.yaml' ? undefined : tree.read(path) };
    const unreadable = await simulateDeleteImpact({ ...common, tree: unreadableTree,
      logWindow: { fromMs: 0, toMs: NOW, complete: true, calls: [] } });
    expect(unreadable.decision).toBe('delete-risk');
    expect(unreadable.unreadablePaths).toEqual(['graphs/work/unknown.yaml']);
    const incompleteKeys = await simulateDeleteImpact({ ...common, callKeyInventoryComplete: false,
      logWindow: { fromMs: 0, toMs: NOW, complete: true, calls: [] } });
    expect(incompleteKeys.decision).toBe('delete-risk');
    for (const censusJson of [JSON.stringify({ reports: 1, cases: 0, complete: true, rows: [] }),
      JSON.stringify({ reports: 1, cases: 1, complete: true, rows: [{ bad: true }] }),
      JSON.stringify({ reports: 1, cases: 1, complete: true, rows: [{ file: 'src/other.test.ts' }] }),
      JSON.stringify({ reports: 1, cases: 1, complete: false, rows: [{ file: 'src/other.test.ts' }] })]) {
      const invalid = await simulateDeleteImpact({ ...common, censusJson,
        logWindow: { fromMs: 0, toMs: NOW, complete: true, calls: [] } });
      expect(invalid.decision).toBe('delete-risk');
      expect(invalid.reasons).toContain('test census invalid or incomplete');
    }
    const unrelatedCensus = JSON.stringify({ reports: 1, cases: 1, complete: true,
      rows: [{ file: 'src/unrelated.test.ts' }] });
    const unrelated = await simulateDeleteImpact({ ...common, censusJson: unrelatedCensus,
      logWindow: { fromMs: 0, toMs: NOW, complete: true, calls: [] } });
    expect(unrelated).toMatchObject({ decision: 'delete-risk', censusMissing: ['src/other.test.ts'] });
    const removedTest = await simulateDeleteImpact({ ...common, removePaths: ['src/unused.ts', 'src/other.test.ts'],
      logWindow: { fromMs: 0, toMs: NOW, complete: true, calls: [] } });
    expect(removedTest).toMatchObject({ decision: 'delete-safe', censusMissing: [] });
    const opaqueTree: ClosureTree = { files: [...tree.files, 'src/dynamic.ts'], preload: [],
      read: path => path === 'src/dynamic.ts' ? 'export const load = (path: string) => import(path);\n' : tree.read(path) };
    const opaque = await simulateDeleteImpact({ ...common, tree: opaqueTree,
      logWindow: { fromMs: 0, toMs: NOW, complete: true, calls: [] } });
    expect(opaque).toMatchObject({ decision: 'delete-risk', remainingImporters: [], virtualOpaque: ['src/dynamic.ts'] });
  } finally { world.dispose(); }
});
