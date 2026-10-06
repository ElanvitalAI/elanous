#!/usr/bin/env bun
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { effectiveInstanceRoot, releaseLedgerRoot } from '../../src/instance/resolve.js';
import { listChecklist } from '../../src/release-loop/checklist.js';
import type { ReleaseManifest } from '../../src/release-loop/manifest.js';
import { recordDocsFollow, type DocsFollowItem } from './release-docs.js';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { errorResult, finishNode, nodeOutput, readGraphContext, runCommand, type CommandRunner } from './node-verdict.js';

export function runDocsLand(run: CommandRunner = runCommand, stateRoot = effectiveInstanceRoot(), ledgerRoot = releaseLedgerRoot()) {
  const context = readGraphContext();
  const version = context.input.version;
  if (context.outputs.publish?.outcome !== 'ok') throw new Error('publish must succeed before docs land');
  if (nodeOutput(context, 'publish', 'tag') !== `v${version}`) throw new Error('published tag/version mismatch');
  const branch = nodeOutput(context, 'docs', 'branch');
  if (branch !== `release-docs/${version}`) throw new Error('docs branch/version mismatch');
  const worktree = nodeOutput(context, 'docs', 'worktree');
  const scratch = dirname(worktree);
  if (dirname(scratch) !== tmpdir() || !/^release-docs-[A-Za-z0-9]+$/.test(scratch.split('/').at(-1) ?? '') || worktree !== join(scratch, 'tree')) throw new Error('invalid docs worktree');
  const recordFollow = (deployed: boolean) => {
    const releaseDir = join(stateRoot, 'release', version);
    const manifest: ReleaseManifest = JSON.parse(readFileSync(join(releaseDir, 'manifest.json'), 'utf8'));
    if (manifest.version !== version || !Array.isArray(manifest.in)) throw new Error('docs-follow manifest/version mismatch');
    // MK attestations are independent of generated notes; missing proof is unmeasured.
    const evidencePath = join(releaseDir, 'docs-follow-evidence.json');
    // 증거 파일이 깨졌으면 «증거 없음»으로 센다 — 보고서·MK 대기열은 그래도 남긴다(미측정으로).
    let raw: unknown = { items: [] };
    try { if (existsSync(evidencePath)) raw = JSON.parse(readFileSync(evidencePath, 'utf8')); }
    catch (error) { process.stderr.write(`docs-follow evidence unreadable — counted as no evidence: ${String(error)}\n`); }
    const valid = !!raw && typeof raw === 'object' && 'items' in raw && Array.isArray((raw as { items: unknown }).items);
    if (!valid) process.stderr.write('docs-follow evidence malformed — counted as no evidence\n');
    // 항목도 하나씩 본다 — 객체이고 문자열 id 가 있는 것만 증거로 센다(나머지는 «증거 없음»).
    const evidence: { items: unknown[] } = { items: valid ? (raw as { items: unknown[] }).items
      .filter((item) => !!item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string') : [] };
    const checklist = listChecklist(version, ledgerRoot);
    const attestations = new Map((evidence.items as DocsFollowItem[]).map((item) => [item.id, item]));
    const items = checklist.items.map((item) => ({ ...attestations.get(item.id), id: item.id, status: item.status,
      ...(deployed ? {} : { docs: undefined }) }));
    const publicationFile = join(ledgerRoot, 'release', version, 'release.json');
    const publication: unknown = existsSync(publicationFile) ? JSON.parse(readFileSync(publicationFile, 'utf8')) : null;
    const publishedAt = publication && typeof publication === 'object' && 'publishedAt' in publication
      && typeof publication.publishedAt === 'string' ? publication.publishedAt : undefined;
    const follow = recordDocsFollow(stateRoot, manifest, items, new Date(), publishedAt);
    return { pending: follow.pending.length, unassessed: follow.unassessed.length, ratio: follow.ratio, verdict: follow.verdict };
  };
  // The deployment error is authoritative even if the follow-up ledger cannot be written.
  const recordFailure = () => {
    try { return recordFollow(false); }
    catch (error) { process.stderr.write(`docs-follow recording failed: ${String(error)}\n`); return undefined; }
  };
  // 재시도 멱등: 노트가 이미 main 에 있으면(앞 판에서 머지됐고 배포만 실패) 착지를 건너뛰고 배포부터.
  const before = run('git', ['fetch', 'origin', 'main']);
  if (before.status !== 0) throw new Error(`docs landing fetch failed: ${before.stderr}`);
  const alreadyLanded = run('git', ['cat-file', '-e', `origin/main:release/public/docs/releases/${version}.md`]).status === 0;
  if (!alreadyLanded) {
    if (!existsSync(worktree)) throw new Error(`docs worktree missing and notes not on main: ${worktree}`);
    const land = run('bun', ['bin/elanous.mjs', 'pr', 'land', '--cwd', worktree]);
    if (land.stderr) process.stderr.write(land.stderr);
    if (land.status === 1) return { outcome: 'fail' as const, verdict: 'fail' as const, summary: `docs land failed: ${land.stderr || land.stdout}`, docsFollow: recordFailure() };
    if (land.status !== 0 || !land.stdout.includes('✓ merge:')) throw new Error(`docs land incomplete (rc=${land.status}): ${land.stderr || land.stdout}`);
  }
  // 착지(병합)는 이미 끝났다 — 이 뒤의 모든 실패는 후속 기록을 시도하고 원래 오류를 그대로 던진다.
  const fetch = run('git', ['fetch', 'origin', 'main']);
  if (fetch.status !== 0) { recordFailure(); throw new Error(`docs landing fetch failed: ${fetch.stderr}`); }
  const merged = run('git', ['rev-parse', 'origin/main']);
  if (merged.status !== 0 || !/^[0-9a-f]{40}\s*$/i.test(merged.stdout)) { recordFailure(); throw new Error(`merged main commit unavailable: ${merged.stderr}`); }
  let deployDir: string;
  try { deployDir = mkdtempSync(join(tmpdir(), 'release-docs-deploy-')); }
  catch (error) { recordFailure(); throw error; }
  const deployTree = join(deployDir, 'tree');
  let added = false;
  let deployed = false;
  try {
    const add = run('git', ['worktree', 'add', '--detach', deployTree, merged.stdout.trim()]);
    if (add.status !== 0) throw new Error(`docs deploy worktree failed: ${add.stderr}`);
    added = true;
    const install = run('bun', ['install', '--frozen-lockfile'], deployTree);
    if (install.status !== 0) throw new Error(`docs deploy install failed: ${install.stderr}`);
    const deploy = run('bun', ['website/scripts/deploy-pages.ts', '--remote', 'node-b', '--yes'], deployTree);
    if (deploy.stderr) process.stderr.write(deploy.stderr);
    if (deploy.status === 1) return { outcome: 'fail' as const, verdict: 'fail' as const,
      summary: `docs deploy failed: ${deploy.stderr || deploy.stdout}`, docsFollow: recordFailure() };
    if (deploy.status !== 0) throw new Error(`docs deploy incomplete (rc=${deploy.status}): ${deploy.stderr || deploy.stdout}`);
    deployed = true;
    if (existsSync(worktree)) {
      const remove = run('git', ['worktree', 'remove', '--force', worktree]);
      if (remove.status !== 0) throw new Error(`docs worktree cleanup failed: ${remove.stderr}`);
    }
    rmSync(scratch, { recursive: true, force: true });
    // 배포 성공 — 후속 기록 실패(manifest 없음 등)는 결과를 «실패»로 바꾸지 않는다. 알리고 넘어간다.
    let follow: ReturnType<typeof recordFollow> | undefined;
    try { follow = recordFollow(true); }
    catch (error) { process.stderr.write(`docs-follow recording failed after deploy: ${String(error)}\n`); }
    return { outcome: 'ok' as const, verdict: 'pass' as const,
      summary: `docs landed and deployed v${version}${follow ? ` · docs-follow pending=${follow.pending} unassessed=${follow.unassessed}` : ' · docs-follow not recorded'}`,
      docsFollow: follow };
  } catch (error) {
    if (!deployed) recordFailure();
    else {
      // 배포는 됐는데 정리에서 실패 — 보고서·MK 대기열은 «배포됨»으로 남기고 원래 오류를 보존한다.
      try { recordFollow(true); }
      catch (recordError) { process.stderr.write(`docs-follow recording failed: ${String(recordError)}\n`); }
    }
    throw error;
  } finally {
    try {
      if (added) {
        const remove = run('git', ['worktree', 'remove', '--force', deployTree]);
        // 배포 임시 트리 정리 실패는 앞선 결과(반환·원래 오류)를 덮지 않는다 — 알리고 넘어간다.
        if (remove.status !== 0) process.stderr.write(`docs deploy cleanup failed (kept the original result): ${remove.stderr}\n`);
      }
    } finally {
      try { rmSync(deployDir, { recursive: true, force: true }); }
      catch (error) { process.stderr.write(`docs deploy temp cleanup failed (kept the original result): ${String(error)}\n`); }
    }
  }
}

if (import.meta.main) {
  let version = '';
  try { version = readGraphContext().input.version; process.exitCode = finishNode('docs-land', version, runDocsLand()); }
  catch (error) { process.exitCode = finishNode('docs-land', version, errorResult(error)); }
}
