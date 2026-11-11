import { buildClosureGraph, type ClosureTree } from '../../scripts/release-loop/gate-closure.js';
import { analyzeGoalImpact } from '../../scripts/sim-impact.js';

const TEST_PATH = /(?:\.(?:test|spec)|_test)\.[cm]?[jt]sx?$/;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000; // Source: assigned 30-day auxiliary log window.

export interface DeleteImpactInput {
  readonly tree: ClosureTree;
  readonly removePaths: readonly string[];
  /** Names used by CLI, menu, graph, or config declarations; empty means discovery is incomplete. */
  readonly callKeys: readonly string[];
  readonly callKeyInventoryComplete: boolean;
  /** JSON from scripts/test-census.ts --format json; JUnit is the measured test inventory. */
  readonly censusJson: string;
  /** Externally enumerated runtime scenario manifest; absent or incomplete inventory cannot prove safety. */
  readonly scenarioInventory?: { readonly paths: readonly string[]; readonly complete: boolean; readonly sourceRef: string;
    readonly dependencies?: Readonly<Record<string, readonly string[]>> };
  readonly nowMs: number;
  readonly logWindow: { readonly fromMs: number; readonly toMs: number; readonly complete: boolean;
    readonly calls: readonly { readonly atMs: number; readonly key: string }[] };
  readonly execute: (selection: { tests: readonly string[]; scenarios: readonly string[]; virtualTree: ClosureTree }) => Promise<{
    readonly passed: boolean; readonly receiptRefs: readonly string[] }>;
  readonly typecheck: (affectedPaths: readonly string[], virtualTree: ClosureTree) => Promise<{
    readonly passed: boolean; readonly receiptRef: string }>;
}

export interface DeleteImpactReceipt {
  readonly universe: 'simulation';
  readonly decision: 'delete-safe' | 'delete-risk';
  readonly removePaths: readonly string[];
  readonly reverseImportClosure: readonly string[];
  readonly remainingImporters: readonly string[];
  readonly surfaces: readonly { kind: 'cli' | 'slash-menu' | 'graph' | 'config' | 'other'; path: string; key: string }[];
  readonly selectedTests: readonly string[];
  readonly selectedScenarios: readonly string[];
  readonly unverifiedScenarios: readonly string[];
  readonly censusMissing: readonly string[];
  readonly censusCasesMissing: readonly string[];
  readonly unreadablePaths: readonly string[];
  readonly virtualOpaque: readonly string[];
  readonly logCalls30d: number | null;
  readonly checkedCallKeys: readonly string[];
  readonly logCoverage: { readonly fromMs: number; readonly toMs: number; readonly complete: boolean };
  readonly checkedLogInterval: { readonly fromMs: number; readonly toMs: number };
  readonly matchedCalls30d: readonly { readonly atMs: number; readonly key: string }[];
  readonly testReceiptRefs: readonly string[];
  readonly typecheckReceiptRef: string;
  readonly reasons: readonly string[];
}

function censusTestFiles(json: string, tracked: ReadonlySet<string>): { files: Set<string>; caseNames: Map<string, string[]>; valid: boolean } {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object' || !('rows' in parsed) || !Array.isArray(parsed.rows)
      || !('complete' in parsed) || parsed.complete !== true
      || !('reports' in parsed) || !Number.isSafeInteger(parsed.reports) || (parsed.reports as number) < 1
      || !('cases' in parsed) || parsed.cases !== parsed.rows.length || parsed.rows.length < 1
      || parsed.rows.some((row: unknown) => !row || typeof row !== 'object' || !('file' in row)
        || typeof row.file !== 'string' || !tracked.has(row.file)
        || !('name' in row) || typeof row.name !== 'string' || !row.name.trim()
        || !('classname' in row) || typeof row.classname !== 'string'
        || !('suitePath' in row) || !Array.isArray(row.suitePath)
        || !('result' in row) || !['passed', 'failed', 'skipped'].includes(row.result as string)
        || !('attempts' in row) || !Array.isArray(row.attempts) || row.attempts.length < 1
        || row.attempts.some((attempt: unknown) => !attempt || typeof attempt !== 'object'
          || !('result' in attempt) || !['passed', 'failed', 'skipped'].includes(attempt.result as string)
          || !('report' in attempt) || typeof attempt.report !== 'string' || !attempt.report.trim())
        || !('sourceStatus' in row) || !['parsed', 'missing'].includes(row.sourceStatus as string)
        || !('caseMatch' in row) || !['matched', 'unmatched'].includes(row.caseMatch as string)))
      return { files: new Set(), caseNames: new Map(), valid: false };
    const caseNames = new Map<string, string[]>();
    for (const row of parsed.rows as { file: string; name: string }[])
      caseNames.set(row.file, [...(caseNames.get(row.file) ?? []), row.name].sort());
    return { files: new Set(caseNames.keys()), caseNames, valid: true };
  } catch { return { files: new Set(), caseNames: new Map(), valid: false }; }
}

function surfaceKind(path: string): DeleteImpactReceipt['surfaces'][number]['kind'] {
  if (path.startsWith('graphs/')) return 'graph';
  if (/(?:^|\/)(?:cli|bin)(?:\/|$)/.test(path)) return 'cli';
  if (/(?:^|\/)(?:tui|dashboard|menu|slash)(?:\/|$)/.test(path)) return 'slash-menu';
  if (/(?:^|\/)(?:config|settings)(?:\/|[.-])/.test(path)) return 'config';
  return 'other';
}

function trackedTest(path: string, source: string | undefined): boolean {
  if (TEST_PATH.test(path) || /(?:^|\/)(?:test|tests)\/.*\.[cm]?[jt]sx?$/.test(path)) return true;
  return /\.[cm]?[jt]sx?$/.test(path) && /(?:^|[^\w$])(?:test|it|describe)\s*\(/m.test(source ?? '');
}

/** Exercise a virtual deletion against the shared impact graph, measured test census, and a bounded log window. */
export async function simulateDeleteImpact(input: DeleteImpactInput): Promise<DeleteImpactReceipt> {
  const all = new Set(input.tree.files);
  const removed = [...new Set(input.removePaths)].sort();
  if (!removed.length || removed.some(path => !all.has(path))) throw new Error('delete-impact target missing from tracked tree');
  if (!input.callKeys.length || input.callKeys.some(key => !key.trim())) throw new Error('delete-impact call keys required');
  if (!Number.isSafeInteger(input.nowMs)) throw new Error('delete-impact clock invalid');
  const removedSet = new Set(removed);
  const goal = analyzeGoalImpact('delete-impact', `대상 경로: ${removed.join(' · ')}\n증명 시나리오: delete-impact`, input.tree);
  const original = buildClosureGraph(input.tree);
  const virtualTree: ClosureTree = { ...input.tree, files: input.tree.files.filter(path => !removedSet.has(path)),
    read: (path) => removedSet.has(path) ? undefined : input.tree.read(path) };
  const virtual = buildClosureGraph(virtualTree);
  const reverse = new Map<string, string[]>();
  for (const [importer, dependencies] of original.forward) for (const dependency of dependencies)
    reverse.set(dependency, [...(reverse.get(dependency) ?? []), importer]);
  const reached = new Set<string>([...removed, ...goal.reverseImportClosure]);
  const queue = [...reached];
  for (let index = 0; index < queue.length; index++) for (const importer of reverse.get(queue[index]!) ?? []) {
    if (!reached.has(importer)) { reached.add(importer); queue.push(importer); }
  }
  const reverseImportClosure = [...reached].sort();
  const remainingImporters = reverseImportClosure.filter(path => !removedSet.has(path));
  const selectedTests = remainingImporters.filter(path => trackedTest(path, input.tree.read(path))).sort();
  const keys = [...new Set([...removed, ...remainingImporters, ...input.callKeys])];
  const scenarioFiles = input.tree.files.filter(path => /(?:^|\/)(?:scenarios|sims)(?:\/|$)/.test(path)
    && !removedSet.has(path));
  const scenarioInventory = input.scenarioInventory;
  const inventoryPaths = new Set(scenarioInventory?.paths ?? []);
  const dependencyLinks = scenarioInventory?.dependencies ?? {};
  const affectedScenarioLinks = new Set(keys);
  for (const path of scenarioFiles) if (keys.some(key => (input.tree.read(path) ?? '').includes(key)))
    affectedScenarioLinks.add(path);
  let grew: boolean;
  do {
    grew = false;
    for (const path of inventoryPaths) if (!affectedScenarioLinks.has(path)
      && dependencyLinks[path]?.some(dependency => affectedScenarioLinks.has(dependency))) {
      affectedScenarioLinks.add(path);
      grew = true;
    }
  } while (grew);
  const relatedScenario = (path: string): boolean => affectedScenarioLinks.has(path)
    || keys.some(key => (input.tree.read(path) ?? '').includes(key));
  const selectedScenarios = scenarioFiles.filter(path => path.startsWith('scenarios/ux-sim/')
    && /\.ya?ml$/.test(path) && relatedScenario(path)).sort();
  // A scenario without a complete dependency link cannot prove irrelevance to a removed feature.
  const selectedScenarioSet = new Set(selectedScenarios);
  const unverifiedScenarios = [...new Set([...scenarioFiles, ...inventoryPaths])]
    .filter(path => {
      if (removedSet.has(path)) return false;
      const dependencies = dependencyLinks[path];
      if (!all.has(path) || !inventoryPaths.has(path) || !dependencies) return true;
      return relatedScenario(path) && !selectedScenarioSet.has(path);
    }).sort();
  const trackedTests = new Set(input.tree.files.filter(path => trackedTest(path, input.tree.read(path))));
  const census = censusTestFiles(input.censusJson, trackedTests);
  const censusMissing = [...trackedTests].filter(path => !census.files.has(path)).sort();
  const censusCasesMissing = [...trackedTests].filter(path => {
    const source = input.tree.read(path);
    if (source === undefined || /(?:^|[^\w$])(?:test|it|describe|suite)\s*\./m.test(source)
      || /\b(?:test|it)\s+as\s+[A-Za-z_$][\w$]*/.test(source)
      || /\b[A-Za-z_$][\w$]*\s*=\s*(?:test|it)\b/.test(source)) return true;
    const declared = [...source.matchAll(/(?:^|[^\w$])(?:test|it)\s*\(\s*(['"])([^'"\r\n]+)\1/g)]
      .map(match => match[2]!).sort();
    const calls = [...source.matchAll(/(?:^|[^\w$])(?:test|it)\s*\(/g)].length;
    return calls === 0 || declared.length !== calls
      || JSON.stringify(declared) !== JSON.stringify(census.caseNames.get(path) ?? []);
  }).sort();
  const unreadablePaths = input.tree.files.filter(path => !removedSet.has(path) &&
    input.tree.read(path) === undefined).sort();
  const surfaces = input.tree.files.filter(path => !removedSet.has(path) && !TEST_PATH.test(path)
      && !path.startsWith('scenarios/ux-sim/'))
    .flatMap(path => {
      const source = input.tree.read(path);
      if (source === undefined) return [];
      return keys.filter(key => source.includes(key)).map(key => ({ kind: surfaceKind(path), path, key }));
    }).sort((a, b) => a.path.localeCompare(b.path) || a.key.localeCompare(b.key));
  // An unresolved import in a surviving file may point at the removed target even when it was already
  // opaque before deletion. No empty reverse closure can turn that uncertainty into delete-safe.
  const virtualOpaque = [...new Set([...original.opaque.keys(), ...virtual.opaque.keys()])]
    .filter(path => !removedSet.has(path) && virtualTree.files.includes(path)).sort();
  const logComplete = input.logWindow.complete && Number.isFinite(input.logWindow.fromMs)
    && Number.isFinite(input.logWindow.toMs) && input.logWindow.calls.every(call => Number.isFinite(call.atMs))
    && input.logWindow.fromMs <= input.nowMs - THIRTY_DAYS_MS && input.logWindow.toMs >= input.nowMs;
  const matchedCalls30d = input.logWindow.calls.filter(call =>
    call.atMs >= input.nowMs - THIRTY_DAYS_MS && call.atMs <= input.nowMs && keys.includes(call.key));
  const logCalls30d = logComplete ? matchedCalls30d.length : null;
  const selection = { tests: selectedTests, scenarios: selectedScenarios, virtualTree };
  const [testResult, typeResult] = await Promise.all([
    input.execute(selection), input.typecheck([...new Set([...removed, ...remainingImporters])].sort(), virtualTree),
  ]);
  const reasons = [
    ...(remainingImporters.length ? [`remaining importers: ${remainingImporters.join(', ')}`] : []),
    ...(surfaces.length ? [`remaining callers: ${surfaces.map(row => `${row.kind}:${row.path}`).join(', ')}`] : []),
    ...(virtualOpaque.length ? [`virtual tree has unresolved imports: ${virtualOpaque.join(', ')}`] : []),
    ...(unreadablePaths.length ? [`unreadable tracked surfaces: ${unreadablePaths.join(', ')}`] : []),
    ...(censusMissing.length ? [`test census missing: ${censusMissing.join(', ')}`] : []),
    ...(censusCasesMissing.length ? [`test cases unverified: ${censusCasesMissing.join(', ')}`] : []),
    ...(unverifiedScenarios.length ? [`scenario dependency unverified: ${unverifiedScenarios.join(', ')}`] : []),
    ...(!scenarioInventory?.complete || !scenarioInventory?.sourceRef.trim() ? ['scenario inventory coverage unmeasured'] : []),
    ...(!census.valid ? ['test census invalid or incomplete'] : []),
    ...(!input.callKeyInventoryComplete ? ['feature call-key inventory incomplete'] : []),
    ...(!testResult.passed || !testResult.receiptRefs.length || testResult.receiptRefs.some(ref => !ref.trim())
      ? ['selected tests/scenarios lack a passing receipt'] : []),
    ...(!typeResult.passed || !typeResult.receiptRef.trim() ? ['affected typecheck lacks a passing receipt'] : []),
    ...(logCalls30d === null ? ['30-day call log coverage unmeasured'] : logCalls30d ? [`30-day calls: ${logCalls30d}`] : []),
  ];
  return { universe: 'simulation', decision: reasons.length ? 'delete-risk' : 'delete-safe', removePaths: removed,
    reverseImportClosure, remainingImporters, surfaces, selectedTests, selectedScenarios, censusMissing, censusCasesMissing, unreadablePaths,
    virtualOpaque, unverifiedScenarios, logCalls30d, checkedCallKeys: keys,
    logCoverage: { fromMs: input.logWindow.fromMs, toMs: input.logWindow.toMs, complete: logComplete },
    checkedLogInterval: { fromMs: input.nowMs - THIRTY_DAYS_MS, toMs: input.nowMs },
    matchedCalls30d, testReceiptRefs: testResult.receiptRefs, typecheckReceiptRef: typeResult.receiptRef, reasons };
}
