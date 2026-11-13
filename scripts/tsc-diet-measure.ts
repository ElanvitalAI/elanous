#!/usr/bin/env bun
/** Read-only, committed-tree measurement. Counterfactuals are structural estimates, not a valid compilation. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { planRootCheck } from './ci-typecheck-changed.js';
import { analyzeImportGraphScc } from './release-loop/import-graph-scc.js';
import { buildClosureGraph, gitClosureTree, testsReachingChangedFromGraph, type ClosureGraph, type ClosureTree } from './release-loop/gate-closure.js';
import { isTestPath, sourceCandidates } from '../src/self-implement/importer-test-index.js';
import { reverseImportAffectedRoots } from '../src/self-implement/pwa-import-graph.js';
import { contractTestCandidate, gitContractRead } from './release-loop/contract-test-select.js';

export type DietCut = { kind: 'edge'; from: string; to: string } | { kind: 'module'; path: string };
export interface DietInput { repo: string; commit: string; baseCommit?: string; files: readonly string[]; cut?: DietCut; includeScc?: boolean }

// Source: cache schema for the serialized ClosureGraph shape below; bump when its meaning changes.
const CACHE_SCHEMA = 1;
type CachedGraph = { schema: number; commit: string; forward: [string, string[]][]; staticImports: [string, string[]][];
  selfStaticImports: string[]; opaque: [string, string][]; tracked: string[] };

function loadGraph(repo: string, commit: string, tree: ClosureTree): { graph: ClosureGraph; cache: 'hit' | 'built' } {
  // The target commit is immutable, but the analyzer may change while comparing branches in one checkout.
  const digest = createHash('sha256').update(resolve(repo)).update(ts.version);
  for (const file of ['./release-loop/gate-closure.ts', './release-loop/gate-cut-snapshot.ts',
    './release-loop/gate-git.ts', '../src/self-implement/importer-test-index.ts',
    '../src/self-implement/lazy-typescript.ts']) {
    digest.update(readFileSync(new URL(file, import.meta.url)));
  }
  const cacheKey = digest.digest('hex').slice(0, 16);
  const dir = join(tmpdir(), 'elanous-tsc-diet', cacheKey);
  const path = join(dir, `${commit}.json`);
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as CachedGraph;
    if (data.schema === CACHE_SCHEMA && data.commit === commit && Array.isArray(data.forward)
      && Array.isArray(data.staticImports) && Array.isArray(data.opaque) && Array.isArray(data.tracked)) {
      return { graph: { forward: new Map(data.forward), staticImports: new Map(data.staticImports),
        selfStaticImports: new Set(data.selfStaticImports), opaque: new Map(data.opaque), tracked: new Set(data.tracked) }, cache: 'hit' };
    }
  } catch { /* missing or invalid cache is rebuilt from the pinned commit */ }
  const tests = tree.files.filter(isTestPath);
  const graph = buildClosureGraph({ ...tree, roots: [...tests, ...tree.preload] });
  const data: CachedGraph = { schema: CACHE_SCHEMA, commit, forward: [...graph.forward].map(([file, edges]) => [file, [...edges]]),
    staticImports: [...graph.staticImports].map(([file, edges]) => [file, [...edges]]), selfStaticImports: [...graph.selfStaticImports],
    opaque: [...graph.opaque], tracked: [...graph.tracked] };
  mkdirSync(dir, { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(data));
  renameSync(temporary, path);
  return { graph, cache: 'built' };
}

export function virtualGraph(graph: ClosureGraph, cut: DietCut, tree: ClosureTree): ClosureGraph {
  const forward = new Map(graph.forward), staticImports = new Map(graph.staticImports);
  const opaque = new Map(graph.opaque), tracked = new Set(graph.tracked);
  if (cut.kind === 'edge') {
    const rewritten = virtualTree(tree, cut);
    // Reparse the changed source: a dynamic import or literal path can still connect the same pair.
    const rebuilt = buildClosureGraph({ ...rewritten, roots: [cut.from],
      read: (file) => file === cut.from ? rewritten.read(file) : undefined });
    forward.set(cut.from, rebuilt.forward.get(cut.from) ?? []);
    staticImports.set(cut.from, rebuilt.staticImports.get(cut.from) ?? []);
    if (rebuilt.opaque.has(cut.from)) opaque.set(cut.from, rebuilt.opaque.get(cut.from)!);
    else opaque.delete(cut.from);
  } else {
    tracked.delete(cut.path);
    forward.delete(cut.path);
    staticImports.delete(cut.path);
    opaque.delete(cut.path);
    for (const [file, edges] of forward) if (edges.includes(cut.path)) {
      forward.set(file, edges.filter((edge) => edge !== cut.path));
      opaque.set(file, `unresolved import ${cut.path}`);
    }
    for (const [file, edges] of staticImports) if (edges.includes(cut.path)) staticImports.set(file, edges.filter((edge) => edge !== cut.path));
  }
  return { ...graph, forward, staticImports, opaque, tracked };
}

function git(repo: string, ...args: string[]): string {
  // git-spawn-allow: read-only revision and changed-path lookup.
  const run = spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_NO_LAZY_FETCH: '1' } });
  if (run.status !== 0) throw new Error(`git ${args[0]} failed: ${run.stderr.trim()}`);
  return run.stdout.trim();
}

function exactCommit(repo: string, ref: string): string {
  const sha = git(repo, 'rev-parse', '--verify', `${ref}^{commit}`);
  if (!/^[0-9a-f]{40}$/i.test(sha)) throw new Error(`invalid commit: ${ref}`);
  return sha;
}

function cutStaticEdge(from: string, to: string, content: string): string {
  const source = ts.createSourceFile(from, content, ts.ScriptTarget.Latest, true, from.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const hits = source.statements.filter((statement) => {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) return false;
    const specifier = statement.moduleSpecifier;
    return !!specifier && ts.isStringLiteralLike(specifier) && specifier.text.startsWith('.')
      && sourceCandidates(from, specifier.text).includes(to);
  });
  if (!hits.length) throw new Error(`static edge not found: ${from} -> ${to}`);
  let result = content;
  for (const statement of [...hits].reverse()) {
    const start = statement.getFullStart(), end = statement.getEnd();
    result = result.slice(0, start) + result.slice(start, end).replace(/[^\n]/g, ' ') + result.slice(end);
  }
  return result;
}

export function virtualTree(tree: ClosureTree, cut: DietCut): ClosureTree {
  if (cut.kind === 'module') {
    if (!tree.files.includes(cut.path)) throw new Error(`module missing at commit: ${cut.path}`);
    return { ...tree, files: tree.files.filter((file) => file !== cut.path), read: (file) => file === cut.path ? undefined : tree.read(file) };
  }
  if (!tree.files.includes(cut.from) || !tree.files.includes(cut.to)) throw new Error('cut edge endpoint missing at commit');
  const content = tree.read(cut.from);
  if (content === undefined) throw new Error(`cut source unreadable: ${cut.from}`);
  const rewritten = cutStaticEdge(cut.from, cut.to, content);
  return { ...tree, read: (file) => file === cut.from ? rewritten : tree.read(file) };
}

function rootPlan(repo: string, tree: ClosureTree, files: readonly string[]) {
  // The repository's ProcessEnv declaration requires NODE_ENV; planRootCheck only reads its two gate overrides.
  return planRootCheck({ wholeRepository: false, rootChanged: new Set(files), cwd: repo, env: { NODE_ENV: 'test' },
    affectedRoots: (_cwd, changed) => reverseImportAffectedRoots(repo, changed, {
      listFiles: () => tree.files.filter((file) => /^(?:src|scripts|test)\/.*\.ts$/.test(file)),
      readFile: (absolute) => {
        const path = relative(repo, absolute).replaceAll('\\', '/');
        const content = tree.read(path);
        if (content === undefined) throw new Error(`committed source unreadable: ${path}`);
        return content;
      },
    }),
  });
}

function profile(repo: string, tree: ClosureTree, graph: ClosureGraph, files: readonly string[], includeScc: boolean) {
  const start = performance.now();
  const tests = tree.files.filter(isTestPath).sort();
  const missing = files.filter((file) => !tree.files.includes(file));
  const reason = missing.length ? `changed path absent at target commit: ${missing.join(', ')}` : '';
  const radius = reason ? { ok: false as const, reason } : testsReachingChangedFromGraph({ ...tree, preload: [] }, files, tests, graph);
  const gate = reason ? { ok: false as const, reason } : testsReachingChangedFromGraph(tree, files, tests, graph);
  const roots = reason ? { mode: 'full' as const, fallbackReason: reason } : rootPlan(repo, tree, files);
  const opaqueCauses = new Map<string, number>();
  for (const reason of graph.opaque.values()) opaqueCauses.set(reason, (opaqueCauses.get(reason) ?? 0) + 1);
  const reverse = new Map<string, string[]>();
  for (const [file, edges] of graph.forward) for (const edge of edges) reverse.set(edge, [...(reverse.get(edge) ?? []), file]);
  const reaching = (seeds: readonly string[]): Set<string> => {
    const seen = new Set(seeds), queue = [...seeds];
    for (let at = 0; at < queue.length; at++) for (const importer of reverse.get(queue[at]!) ?? []) {
      if (seen.has(importer)) continue;
      seen.add(importer); queue.push(importer);
    }
    return seen;
  };
  const definite = reaching(files);
  const opaqueCauseImpacts = [...opaqueCauses].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 12)
    .map(([cause, filesWithCause]) => {
      const affected = reaching([...graph.opaque].filter(([, why]) => why === cause).map(([file]) => file));
      return { cause, filesWithCause, additionalTests: tests.filter((test) => !definite.has(test) && affected.has(test)).length };
    });
  const scc = includeScc && gate.ok
    ? analyzeImportGraphScc(tree, gate.tests, { complete: true, issues: [] }, {}, files, graph)
    : undefined;
  return {
    tsc: roots.mode === 'affected' ? { mode: roots.mode, rootCount: roots.roots.length, roots: roots.roots }
      : { mode: roots.mode, reason: roots.fallbackReason },
    gate: gate.ok ? { mode: 'radius', selectedTests: gate.tests.length, definiteTests: gate.reached, opaqueAdditional: gate.opaque }
      : { mode: 'full-fallback', selectedTests: tests.length, reason: gate.reason },
    diagnosticRadius: radius.ok ? { selectedTests: radius.tests.length, definiteTests: radius.reached, opaqueAdditional: radius.opaque }
      : { selectedTests: tests.length, reason: radius.reason },
    totalTests: tests.length,
    opaqueFiles: graph.opaque.size,
    opaqueCauses: [...opaqueCauses].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 12),
    opaqueCauseImpacts,
    scc: scc && { cycleCount: scc.cycleCount, largestScc: scc.largestScc, cutCandidateTotal: scc.cutCandidateTotal,
      cutCandidates: scc.cutCandidates.map(({ from, to, sccSize, impactedTests }) => ({ from, to, sccSize, impactedTests: impactedTests.length })) },
    elapsedMs: Math.round(performance.now() - start),
  };
}

export function measureTscDiet(input: DietInput) {
  if (!/^[0-9a-f]{40}$/i.test(input.commit)) throw new Error('commit must be a full SHA');
  const start = performance.now();
  const tree = gitClosureTree(input.repo, input.commit);
  const files = [...new Set(input.files)].sort();
  if (!files.length) throw new Error('no changed files');
  const { graph, cache } = loadGraph(input.repo, input.commit, tree);
  const before = profile(input.repo, tree, graph, files, input.includeScc ?? false);
  const after = input.cut ? profile(input.repo, virtualTree(tree, input.cut), virtualGraph(graph, input.cut, tree), files, false) : undefined;
  const tests = tree.files.filter(isTestPath).sort();
  const contractSelection = input.baseCommit
    ? contractTestCandidate({ tree, priorRead: gitContractRead(input.repo, input.baseCommit), changed: files, tests })
    : { status: 'full' as const, reason: 'baseline commit unavailable', files: tests, direct: 0, twoHop: 0 };
  return { commit: input.commit, baseCommit: input.baseCommit ?? null, changedFiles: files, cut: input.cut, cache, elapsedMs: Math.round(performance.now() - start),
    contractSelection,
    analyzerCheckout: resolve(import.meta.dir, '..'), before, after,
    note: 'The analyzer runs from analyzerCheckout, which may differ from the measured commit. Counterfactuals only change the in-memory source graph; TypeScript validity and runtime behavior require a real code change and gate.' };
}

function parse(args: string[]) {
  const includeScc = args.includes('--scc');
  args = args.filter((arg) => arg !== '--scc');
  const values = new Map<string, string>();
  for (let at = 0; at < args.length; at += 2) {
    const key = args[at], value = args[at + 1];
    if (!key || !value || !['--repo', '--commit', '--branch', '--base', '--files', '--cut-edge', '--delete-module'].includes(key) || values.has(key)) throw new Error('invalid arguments');
    values.set(key, value);
  }
  if (values.has('--commit') === values.has('--branch')) throw new Error('pass exactly one of --commit or --branch');
  if (values.has('--cut-edge') && values.has('--delete-module')) throw new Error('pass one virtual change');
  const repo = resolve(values.get('--repo') ?? process.cwd());
  const commit = exactCommit(repo, values.get('--commit') ?? values.get('--branch')!);
  const explicitFiles = values.get('--files')?.split(',').map((file) => file.trim());
  let baseCommit: string | undefined;
  try { baseCommit = exactCommit(repo, values.get('--base') ?? 'origin/main'); }
  catch (error) {
    if (!explicitFiles) throw error;
  }
  const files = explicitFiles ?? (baseCommit
    ? git(repo, 'diff', '--no-renames', '--name-only', `${baseCommit}...${commit}`).split('\n').filter(Boolean)
    : undefined);
  if (!files) throw new Error('base commit unavailable; pass --files or an available --base');
  const edge = values.get('--cut-edge')?.split(':');
  if (edge && (edge.length !== 2 || edge.some((part) => !part))) throw new Error('cut edge must be from:to');
  const cut: DietCut | undefined = edge ? { kind: 'edge', from: edge[0]!, to: edge[1]! }
    : values.get('--delete-module') ? { kind: 'module', path: values.get('--delete-module')! } : undefined;
  return { repo, commit, ...(baseCommit ? { baseCommit } : {}), files, cut, includeScc };
}

if (import.meta.main) {
  try { process.stdout.write(`${JSON.stringify(measureTscDiet(parse(process.argv.slice(2))))}\n`); }
  catch (cause) {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.stderr.write('usage: bun scripts/tsc-diet-measure.ts (--commit REF|--branch REF) [--base REF] [--files path,path] [--cut-edge from:to|--delete-module path] [--scc] [--repo checkout]\n');
    process.exitCode = 2;
  }
}
