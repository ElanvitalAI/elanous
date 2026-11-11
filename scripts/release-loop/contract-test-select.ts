/** Experimental contract selector. Its result is observation only until historical replay proves safety. */
import ts from 'typescript';
import { spawnSync } from 'node:child_process';
import { buildClosureGraph, type ClosureTree } from './gate-closure.js';
import surfaces from './gate-contract-surfaces.json';

const targets = ['src/graph-runner/runner.ts', 'scripts/release-loop/gate-node.ts'] as const;
const testPath = /\.test\.(?:tsx?|jsx?|mts|cts)$/;
type Contract = { names: string[]; signatures: string[] };

/** Explicit exports plus declaration shapes. Function bodies are implementation; inferred exports retain their initializer. */
export function publicContract(path: string, code: string): Contract {
  const source = ts.createSourceFile(path, code, ts.ScriptTarget.Latest, true);
  if ((source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics?.length)
    throw new Error(`unparseable public contract: ${path}`);
  const names: string[] = [];
  const signatures: string[] = [];
  for (const statement of source.statements) {
    const exported = ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    if (ts.isExportAssignment(statement)
      || (exported && ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)))
      throw new Error(`unsupported default export: ${path}`);
    if (ts.isExportDeclaration(statement)) {
      if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) throw new Error(`unbounded re-export: ${path}`);
      const kind = statement.isTypeOnly ? 'type' : 'value';
      for (const spec of statement.exportClause.elements) {
        const name = spec.name.text;
        names.push(name);
        signatures.push(`${kind}:${name}:${statement.moduleSpecifier?.getText(source) ?? ''}:${spec.propertyName?.text ?? name}`);
      }
    } else if (exported && (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)
      || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement))) {
      if (!statement.name) throw new Error(`anonymous public declaration: ${path}`);
      names.push(statement.name.text);
      const end = ts.isFunctionDeclaration(statement) && statement.body ? statement.body.getStart(source) : statement.end;
      signatures.push(`${statement.name.text}:${code.slice(statement.getStart(source), end).trim()}`);
    } else if (exported && ts.isVariableStatement(statement)) {
      const declarationKind = statement.declarationList.flags & ts.NodeFlags.Const ? 'const'
        : statement.declarationList.flags & ts.NodeFlags.Let ? 'let' : 'var';
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) throw new Error(`destructured public declaration: ${path}`);
        names.push(declaration.name.text);
        // A public const's initializer is observable even with an explicit type annotation.
        signatures.push(`${declarationKind}:${declaration.name.text}:${declaration.type?.getText(source) ?? ''}:${declaration.initializer?.getText(source) ?? ''}`);
      }
    } else if (exported) throw new Error(`unknown public declaration: ${path}`);
  }
  return { names: names.sort(), signatures: signatures.sort() };
}

export interface ContractTestCandidate {
  status: 'limited' | 'full';
  reason: string;
  files: string[];
  direct: number;
  twoHop: number;
}

/** Join the candidate to the failure IDs from the same fully measured cut sweep. */
export function compareContractShadowFailures(input: { candidate: ContractTestCandidate; tests: readonly string[];
  measuredFiles: readonly string[] | null; failureIds: readonly string[] | null; sweepComplete: boolean;
  fileOfId: (id: string) => string }) {
  const unknown = (reason: string) => ({ comparison: 'unmeasured' as const, comparisonReason: reason,
    savedTests: null, observedFailureIds: null, observedFailureCount: null,
    missedFailures: null, missedFailureCount: null });
  if (!input.sweepComplete || !input.measuredFiles || !input.failureIds) return unknown('full cut sweep unmeasured');
  if (JSON.stringify([...input.measuredFiles].sort()) !== JSON.stringify([...input.tests].sort()))
    return unknown('measured test inventory differs from gate inventory');
  const observedFailureIds = [...new Set(input.failureIds)].sort();
  const inventory = new Set(input.tests);
  const selected = new Set(input.candidate.files);
  const missedFailures: string[] = [];
  for (const id of observedFailureIds) {
    let file: string;
    try { file = input.fileOfId(id); } catch { return unknown('failure ID cannot be mapped to a test file'); }
    if (!inventory.has(file)) return unknown('failure file absent from gate inventory');
    if (!selected.has(file)) missedFailures.push(id);
  }
  return { comparison: 'complete' as const, comparisonReason: null,
    savedTests: input.candidate.status === 'limited' ? input.tests.length - input.candidate.files.length : 0,
    observedFailureIds, observedFailureCount: observedFailureIds.length,
    missedFailures, missedFailureCount: missedFailures.length };
}

/** Changed tests run as well; unrelated code and configuration changes retain the full radius. */
export function contractTestCandidate(input: { tree: ClosureTree; priorRead: (path: string) => string | undefined;
  changed: readonly string[]; tests: readonly string[] }): ContractTestCandidate {
  const full = (reason: string): ContractTestCandidate => ({ status: 'full', reason, files: [...input.tests], direct: 0, twoHop: 0 });
  if (!input.changed.length || input.changed.some((path) => !targets.includes(path as typeof targets[number]) && !testPath.test(path)))
    return full('change outside declared implementations');
  try {
    for (const path of input.changed.filter((entry) => targets.includes(entry as typeof targets[number]))) {
      const prior = input.priorRead(path);
      const next = input.tree.read(path);
      if (prior === undefined || next === undefined) return full(`unreadable contract: ${path}`);
      const before = publicContract(path, prior);
      const after = publicContract(path, next);
      const declared = surfaces[path as keyof typeof surfaces];
      if (JSON.stringify(before.names) !== JSON.stringify(declared) || JSON.stringify(after.names) !== JSON.stringify(declared))
        return full(`export list differs from declaration: ${path}`);
      if (JSON.stringify(before.signatures) !== JSON.stringify(after.signatures)) return full(`public contract changed: ${path}`);
    }
    const graph = buildClosureGraph(input.tree);
    const reverse = new Map<string, Set<string>>();
    for (const [from, dependencies] of graph.forward) for (const dependency of dependencies) {
      const importers = reverse.get(dependency) ?? new Set<string>();
      importers.add(from);
      reverse.set(dependency, importers);
    }
    const direct = new Set<string>(input.changed.filter((path) => testPath.test(path)));
    for (const path of input.changed) for (const importer of reverse.get(path) ?? []) if (testPath.test(importer)) direct.add(importer);
    const twoHop = new Set(direct);
    for (const path of input.changed) for (const importer of reverse.get(path) ?? [])
      for (const test of reverse.get(importer) ?? []) if (testPath.test(test)) twoHop.add(test);
    const known = new Set(input.tests);
    if ([...twoHop].some((path) => !known.has(path))) return full('selected test absent from gate inventory');
    return { status: 'limited', reason: 'unchanged declared public contract (shadow only)',
      files: [...twoHop].sort(), direct: direct.size, twoHop: twoHop.size };
  } catch (error) { return full(`contract evidence unreadable: ${String(error)}`); }
}

export function gitContractRead(repo: string, commit: string): (path: string) => string | undefined {
  return (path) => {
    const result = spawnSync('git', ['show', `${commit}:${path}`], { cwd: repo, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    return result.status === 0 && !result.error ? result.stdout : undefined;
  };
}
