#!/usr/bin/env bun
/** Read-only OP train adapter: one JSON decision, never launches a gate or edits a queue. */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { decidePrGateCache } from './release-loop/gate-pr-cache.js';
import { buildClosureGraph, gitClosureTree, testsReachingChanged } from './release-loop/gate-closure.js';

const SHA = /^[0-9a-f]{40}$/i;
const argv = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const summaryPath = option('--summary');
const repo = option('--repo');
const head = option('--head')?.toLowerCase();
const main = option('--main')?.toLowerCase();
const singlePr = argv.includes('--single-pr');
if (!summaryPath || !repo || !head || !main || !SHA.test(head) || !SHA.test(main) || !singlePr) {
  console.error('usage: bun scripts/gate-pr-cache.ts --summary <author-summary.json> --repo <git-repo> --head <PR-head40> --main <main40> --single-pr');
  process.exit(2);
}
const git = (args: string[]): { status: number | null; stdout: string } => {
  // git-spawn-allow: read-only object ancestry and path diff; this adapter never checks out or mutates.
  const result = spawnSync('git', args, { cwd: resolve(repo), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return { status: result.status, stdout: result.stdout ?? '' };
};
let summary: unknown;
try { summary = JSON.parse(readFileSync(summaryPath, 'utf8')); } catch { summary = null; }
const base = summary && typeof summary === 'object' && 'base40' in summary && typeof summary.base40 === 'string'
  ? summary.base40.toLowerCase() : '';
const baseAncestorOfHead = SHA.test(base) && git(['merge-base', '--is-ancestor', base, head]).status === 0;
const baseAncestorOfMain = SHA.test(base) && git(['merge-base', '--is-ancestor', base, main]).status === 0;
const diff = baseAncestorOfMain ? git(['-c', 'core.quotepath=off', 'diff', '--name-only', '--no-renames', `${base}..${main}`]) : null;
const mainChangedFiles = diff?.status === 0 ? diff.stdout.split(/\r?\n/).filter(Boolean) : null;
const docs = mainChangedFiles?.filter((file) => /\.md$/.test(file));
const added = docs?.length ? git(['-c', 'core.quotepath=off', 'diff', '--name-only', '--no-renames', '--diff-filter=A', `${base}..${main}`]) : null;
const inertDocsAddedOnly = docs ? (!docs.length || (added?.status === 0 && docs.every((file) => added.stdout.split(/\r?\n/).includes(file)))) : null;
let affectedTests: string[] | null = null;
let sourceDependencyOverlap: boolean | null = null;
if (mainChangedFiles && summary && typeof summary === 'object' && 'cohort' in summary && Array.isArray(summary.cohort)) {
  const code = mainChangedFiles.filter((file) => /\.[cm]?[jt]sx?$/.test(file));
  if (!code.length) { affectedTests = []; sourceDependencyOverlap = false; }
  else try {
    const tree = gitClosureTree(resolve(repo), head);
    const prDiff = SHA.test(base) ? git(['-c', 'core.quotepath=off', 'diff', '--name-only', '--no-renames', `${base}..${head}`]) : null;
    const prChanged = prDiff?.status === 0 ? prDiff.stdout.split(/\r?\n/).filter(Boolean) : null;
    if (prChanged && code.every((file) => tree.files.includes(file))
      && prChanged.every((file) => /\.[cm]?[jt]sx?$/.test(file) || (/\.md$/.test(file) && !/(?:^|\/)(?:test|tests|__tests__|fixtures|__fixtures__|__snapshots__|__mocks__)\//.test(file)))) {
      const graph = buildClosureGraph(tree);
      const seen = new Set(prChanged.filter((file) => /\.[cm]?[jt]sx?$/.test(file)));
      const pending = [...seen];
      while (pending.length) for (const dependency of graph.forward.get(pending.pop()!) ?? []) {
        if (!seen.has(dependency)) { seen.add(dependency); pending.push(dependency); }
      }
      if ([...seen].some((file) => graph.opaque.has(file) || !graph.tracked.has(file))) throw new Error('PR source closure opaque');
      sourceDependencyOverlap = code.some((file) => seen.has(file));
      const closure = testsReachingChanged(tree, code, summary.cohort);
      if (closure.ok) affectedTests = closure.tests;
    }
  } catch { /* unknown radius means full gate */ }
}
console.log(JSON.stringify(decidePrGateCache({ summary, head, main, singlePr,
  baseAncestorOfHead, baseAncestorOfMain, mainChangedFiles, inertDocsAddedOnly, affectedTests, sourceDependencyOverlap }), null, 2));
