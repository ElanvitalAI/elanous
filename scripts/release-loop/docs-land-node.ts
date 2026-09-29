#!/usr/bin/env bun
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { errorResult, finishNode, nodeOutput, readGraphContext, runCommand, type CommandRunner } from './node-verdict.js';

export function runDocsLand(run: CommandRunner = runCommand) {
  const context = readGraphContext();
  const version = context.input.version;
  if (context.outputs.publish?.outcome !== 'ok') throw new Error('publish must succeed before docs land');
  if (nodeOutput(context, 'publish', 'tag') !== `v${version}`) throw new Error('published tag/version mismatch');
  const branch = nodeOutput(context, 'docs', 'branch');
  if (branch !== `release-docs/${version}`) throw new Error('docs branch/version mismatch');
  const worktree = nodeOutput(context, 'docs', 'worktree');
  const scratch = dirname(worktree);
  if (dirname(scratch) !== tmpdir() || !/^release-docs-[A-Za-z0-9]+$/.test(scratch.split('/').at(-1) ?? '') || worktree !== join(scratch, 'tree')) throw new Error('invalid docs worktree');
  // 재시도 멱등: 노트가 이미 main 에 있으면(앞 판에서 머지됐고 배포만 실패) 착지를 건너뛰고 배포부터.
  const before = run('git', ['fetch', 'origin', 'main']);
  if (before.status !== 0) throw new Error(`docs landing fetch failed: ${before.stderr}`);
  const alreadyLanded = run('git', ['cat-file', '-e', `origin/main:release/public/docs/releases/${version}.md`]).status === 0;
  if (!alreadyLanded) {
    if (!existsSync(worktree)) throw new Error(`docs worktree missing and notes not on main: ${worktree}`);
    const land = run('bun', ['bin/elanous.mjs', 'pr', 'land', '--cwd', worktree]);
    if (land.stderr) process.stderr.write(land.stderr);
    if (land.status === 1) return { outcome: 'fail' as const, verdict: 'fail' as const, summary: `docs land failed: ${land.stderr || land.stdout}` };
    if (land.status !== 0 || !land.stdout.includes('✓ merge:')) throw new Error(`docs land incomplete (rc=${land.status}): ${land.stderr || land.stdout}`);
  }
  const fetch = run('git', ['fetch', 'origin', 'main']);
  if (fetch.status !== 0) throw new Error(`docs landing fetch failed: ${fetch.stderr}`);
  const merged = run('git', ['rev-parse', 'origin/main']);
  if (merged.status !== 0 || !/^[0-9a-f]{40}\s*$/i.test(merged.stdout)) throw new Error(`merged main commit unavailable: ${merged.stderr}`);
  const deployDir = mkdtempSync(join(tmpdir(), 'release-docs-deploy-'));
  const deployTree = join(deployDir, 'tree');
  let added = false;
  try {
    const add = run('git', ['worktree', 'add', '--detach', deployTree, merged.stdout.trim()]);
    if (add.status !== 0) throw new Error(`docs deploy worktree failed: ${add.stderr}`);
    added = true;
    const install = run('bun', ['install', '--frozen-lockfile'], deployTree);
    if (install.status !== 0) throw new Error(`docs deploy install failed: ${install.stderr}`);
    const deploy = run('bun', ['website/scripts/deploy-pages.ts', '--remote', 'node-b', '--yes'], deployTree);
    if (deploy.stderr) process.stderr.write(deploy.stderr);
    if (deploy.status === 1) return { outcome: 'fail' as const, verdict: 'fail' as const, summary: `docs deploy failed: ${deploy.stderr || deploy.stdout}` };
    if (deploy.status !== 0) throw new Error(`docs deploy incomplete (rc=${deploy.status}): ${deploy.stderr || deploy.stdout}`);
    if (existsSync(worktree)) {
      const remove = run('git', ['worktree', 'remove', '--force', worktree]);
      if (remove.status !== 0) throw new Error(`docs worktree cleanup failed: ${remove.stderr}`);
    }
    rmSync(scratch, { recursive: true, force: true });
    return { outcome: 'ok' as const, verdict: 'pass' as const, summary: `docs landed and deployed v${version}` };
  } finally {
    try {
      if (added) {
        const remove = run('git', ['worktree', 'remove', '--force', deployTree]);
        if (remove.status !== 0) throw new Error(`docs deploy cleanup failed: ${remove.stderr}`);
      }
    } finally { rmSync(deployDir, { recursive: true, force: true }); }
  }
}

if (import.meta.main) {
  let version = '';
  try { version = readGraphContext().input.version; process.exitCode = finishNode('docs-land', version, runDocsLand()); }
  catch (error) { process.exitCode = finishNode('docs-land', version, errorResult(error)); }
}
