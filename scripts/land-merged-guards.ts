#!/usr/bin/env bun
/** Guard the exact main + PR merge before a direct landing. */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// #39166/#39336: the boundary can be broken by a PR whose own base predates the guard.
export const LAND_MERGED_GUARD_TESTS = [
  'src/els/boundary.test.ts',
  'src/els/boundary-scan.test.ts',
  'src/els/same-uid-seat-boundary.test.ts',
  'scripts/ratchets/test-interference-patterns.test.ts',
  'test/rules-contract.test.ts',
] as const;

export function runLandMergedGuards(cwd: string, main: string, head: string): number {
  if (!/^[a-f0-9]{40}$/.test(main) || !/^[a-f0-9]{40}$/.test(head)) {
    console.error('LAND_MERGED_GUARDS result=unmeasured reason=invalid-identity'); return 2;
  }
  const git = spawnSync('git', ['rev-list', '--parents', '-n', '1', 'HEAD'], { cwd, encoding: 'utf8' });
  const parents = git.stdout?.trim().split(/\s+/) ?? [];
  if (git.status !== 0 || parents.length !== 3 || parents[1] !== main || parents[2] !== head) {
    console.error('LAND_MERGED_GUARDS result=unmeasured reason=merge-identity-mismatch'); return 2;
  }
  const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd, encoding: 'utf8' });
  if (status.status !== 0 || status.stdout.trim()) {
    console.error('LAND_MERGED_GUARDS result=unmeasured reason=merge-worktree-dirty'); return 2;
  }
  const missing = LAND_MERGED_GUARD_TESTS.filter(file => !existsSync(join(cwd, file)));
  if (missing.length) {
    console.error(`LAND_MERGED_GUARDS result=unmeasured reason=missing-guard files=${missing.join(',')}`); return 2;
  }
  const result = spawnSync(process.execPath, ['test', ...LAND_MERGED_GUARD_TESTS], {
    cwd, encoding: 'utf8', timeout: 300_000, maxBuffer: 16 * 1024 * 1024, // 출처: #39166 — fail closed if guard is unmeasured
  }); // 출처: #39166 — merged-tree boundary and ratchet guard
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error || result.status === null) {
    console.error(`LAND_MERGED_GUARDS result=unmeasured reason=${result.error?.message ?? 'signal'}`); return 2;
  }
  if (result.status !== 0) {
    console.error(`LAND_MERGED_GUARDS result=failed main=${main} head=${head} rc=${result.status}`); return 1;
  }
  console.log(`LAND_MERGED_GUARDS result=passed main=${main} head=${head} merge=${parents[0]}`); return 0;
}

if (import.meta.main) process.exitCode = runLandMergedGuards(process.cwd(), process.argv[2] ?? '', process.argv[3] ?? '');
