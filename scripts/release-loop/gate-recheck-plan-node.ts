#!/usr/bin/env bun
// Shadow node: prepare a same-commit, failed-files-only plan. The gate consumer is a separate TC change.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planSameCommitRecheck, writeRecheckPlan } from './gate-partial';

export interface RecheckInput {
  version: string;
  commit: string;
  measuredCommit: string;
  failures: string[];
  errors: string[];
  ledgerRoot: string;
}

/** Only a Git blob is a runnable test file; `cat-file -e` also accepts trees. */
export function existsTestFileAtCommit(repo: string, commit: string, file: string): boolean {
  // git-spawn-allow: read-only object type check at the exact measured release commit.
  const found = spawnSync('git', ['cat-file', '-t', `${commit}:${file}`], { cwd: repo, encoding: 'utf8' });
  if (found.error) throw found.error;
  return found.status === 0 && found.stdout.trim() === 'blob';
}

export function prepareGateRecheck(input: RecheckInput, existsAtCommit: (file: string) => boolean):
  { outcome: 'ok'; planPath: string; files: string[]; summary: string } |
  { outcome: 'fail'; planPath: null; files: string[]; summary: string } {
  const fail = (summary: string) => ({ outcome: 'fail' as const, planPath: null, files: [], summary });
  if (!input || typeof input !== 'object' || typeof input.ledgerRoot !== 'string' || !input.ledgerRoot.trim() ||
      !Array.isArray(input.failures) || !input.failures.every((id) => typeof id === 'string') ||
      !Array.isArray(input.errors) || !input.errors.every((id) => typeof id === 'string')) return fail('invalid recheck input');
  const planned = planSameCommitRecheck({ version: input.version, measuredCommit: input.measuredCommit,
    forCommit: input.commit, failures: input.failures, errors: input.errors, existsAtCommit });
  if (!planned.ok) return fail(planned.reason);
  try {
    const planPath = writeRecheckPlan(input.ledgerRoot, planned.plan);
    return { outcome: 'ok', planPath, files: planned.plan.files, summary: `${planned.plan.files.length} failed test files planned on same commit` };
  } catch (error) { return fail(String(error instanceof Error ? error.message : error)); }
}

function main(): void {
  const contextPath = process.env.ELANOUS_GRAPH_CONTEXT;
  if (!contextPath) throw new Error('ELANOUS_GRAPH_CONTEXT required');
  const context = JSON.parse(readFileSync(contextPath, 'utf8')) as { input?: RecheckInput };
  const repo = resolve(import.meta.dir, '../..');
  const input = context.input as RecheckInput;
  const result = prepareGateRecheck(input, (file) => existsTestFileAtCommit(repo, input.commit, file));
  console.log(JSON.stringify(result));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
