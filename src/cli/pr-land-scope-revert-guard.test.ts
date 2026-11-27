// LAND-SCOPE-REVERT-GUARD — 착지의 `git add -A` 가 «PR 범위 밖» 되돌림을 그대로 커밋하는 것을 커밋 «전»에 막는다.
//
// 사고 원형(2026-08-24): `git checkout <ref> -- <file>` 이 index+worktree 를 되돌렸고,
// 착지의 `git add -A` 가 그 되돌림을 커밋에 흡수했다. 이 시험은 실제 git 무대로
// (a) PR 범위 밖 경로를 base 내용으로 되돌린 착지가 'scope-revert-guard' 거부로 커밋 «전»에 멈추는 것 ·
// (b) 되돌림 없는 착지가 그대로 성립하는 것(양성 대칭)을 증명한다.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { resetEffectiveInstanceRoot } from '../instance/resolve.js';
import { runPrLand, type PrLandDeps } from './pr-cli.js';

const PR_URL = 'https://github.com/example/repo/pull/26022';

let freezeRoot = '';
let stateDir = '';
let savedStateDir: string | undefined;
beforeEach(() => {
  freezeRoot = mkdtempSync(join(tmpdir(), 'pr-land-scope-revert-freeze-'));
  stateDir = mkdtempSync(join(tmpdir(), 'pr-land-scope-revert-state-'));
  savedStateDir = process.env.ELANOUS_STATE_DIR;
  process.env.ELANOUS_STATE_DIR = stateDir;
  resetEffectiveInstanceRoot();
});
afterEach(() => {
  if (savedStateDir === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = savedStateDir;
  resetEffectiveInstanceRoot();
  rmSync(freezeRoot, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

/** 실제 git 무대 — PR 범위=A.ts, base(origin/main) 는 B.ts 에서 앞서 갔다. revert=true 면 사고 원형처럼 B.ts 를 base 내용으로 되돌린다. */
async function landOnRevertedScope(revertOutOfScopePath: boolean, path = 'B.ts', options: { downgrade?: boolean; intentional?: boolean } = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'pr-land-scope-revert-'));
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    return result.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  writeFileSync(join(repo, '.gitignore'), '.state/\n');
  writeFileSync(join(repo, 'A.ts'), 'a-base\n');
  writeFileSync(join(repo, path), path === 'package.json' ? `{"version":"${options.downgrade ? '1.1.0' : '1.0.0'}"}\n` : 'b-base\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  git('checkout', '-qb', 'feature');
  writeFileSync(join(repo, 'A.ts'), 'a-pr\n');
  if (options.intentional) writeFileSync(join(repo, path), '{"version":"1.2.0"}\n');
  git('commit', '-qam', 'PR intent'); // intentional 사례는 package.json도 PR 범위에 포함한다.
  const head = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'main');
  writeFileSync(join(repo, path), path === 'package.json' ? `{"version":"${options.downgrade ? '1.0.0' : '1.1.0'}"}\n` : 'b-base-moved\n'); // base advances the selected file.
  // ⛔ 커밋해야 base 의 «실제» 전진이다 — 커밋 없으면 뒤의 `checkout origin/main -- B.ts` 되돌림이
  //    HEAD 의 B.ts 내용('b-base')로 되돌리는 것이라 작업트리에 아무 차이를 남기지 않는다(no-op).
  git('commit', '-qam', 'base advances B.ts');
  const main = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'feature');
  git('remote', 'add', 'origin', 'https://github.com/example/repo.git');
  git('update-ref', 'refs/remotes/origin/main', main);
  if (revertOutOfScopePath) git('checkout', 'origin/main', '--', path); // 사고 원형: 범위 밖 B.ts 를 base 내용으로 되돌림(삭제 우세 아님)
  const reviewResultsDir = join(repo, '.state', 'review-results');
  mkdirSync(reviewResultsDir, { recursive: true });
  writeFileSync(join(reviewResultsDir, `pr-26022-${head.slice(0, 12)}.json`), JSON.stringify({
    pr: 26022, headCommit: head, reviewed: true, verdict: 'pass', mustFix: [],
  }));
  const lines: string[] = [];
  let merges = 0;
  const manager: PrLandDeps['manager'] = {
    findPrForBranchOutcome: () => ({ status: 'ok OUTPUT', url: PR_URL }),
    upsertPr: () => ({ ok: true, url: PR_URL, reused: true }),
    mergePrOutcome: () => { merges++; return { ok: true, kind: 'merged' }; },
  } as unknown as PrLandDeps['manager'];
  const run: NonNullable<PrLandDeps['run']> = (command, args, options) => {
    if (command === 'git' && args[0] === 'fetch') return { ok: true, out: '' };
    if (command === 'git' && args[0] === 'ls-remote') return { ok: true, out: `${main}\trefs/heads/main\n` };
    if (command === 'git' && args[0] === 'push') return { ok: true, out: '' };
    if (command === 'gh' && args.includes('mergeable,mergeStateStatus')) return { ok: true, out: 'CLEAN CLEAN' };
    if (command === 'gh' && args.includes('title,body')) return { ok: true, out: JSON.stringify({ title: 'PR title intent', body: 'PR body intent' }) };
    if (command === 'gh' && args.some((arg) => String(arg).includes('mergeCommit'))) return { ok: true, out: JSON.stringify({ state: 'MERGED', mergeCommit: { oid: 'c'.repeat(40) } }) };
    if (command === 'gh') return { ok: true, out: JSON.stringify({ headRefOid: head, headRefName: 'feature', baseRefName: 'main', state: 'OPEN', isDraft: false, url: PR_URL }) };
    const result = spawnSync(command, [...args], { cwd: options?.cwd ?? repo, encoding: 'utf8' });
    return { ok: result.status === 0, out: result.stdout ?? '', err: result.stderr ?? '' };
  };
  const code = await runPrLand({ base: 'main', cwd: repo }, {
    prodFreezeRoot: freezeRoot, manager, run, reviewResultsDir,
    currentBranch: () => 'feature', resolveBase: () => 'origin/main',
    listUnfinishedRuns: () => [], listOpenPrs: () => [], isInteractive: () => false,
    runTypecheckGate: () => true, runIsolationGate: () => true, runMockModuleRestoreGate: () => true,
    runModelHardcodeGate: () => true, runDaemonPortGate: () => true, runPublicLeakGate: () => 0,
    runExportLeakCheck: () => ({ measured: true, hits: [] }), runExportImportCheck: () => ({ measured: true, hits: [], unseen: 0 }),
    runTestInterferenceGate: async () => 0,
    runLandGlobalChecks: () => true, runAndroidGate: () => true, runPwaGate: () => true, runIosGate: () => true,
    out: { log: (line) => lines.push(line), error: (line) => lines.push(line) },
  });
  return { code, lines, merges: () => merges, git, head };
}

test('PR 범위 밖 경로를 base 내용으로 되돌린 착지는 scope-revert-guard 로 커밋 전에 거부된다', async () => {
  const outcome = await landOnRevertedScope(true);
  expect(outcome.code).toBe(1);
  expect(outcome.merges()).toBe(0);
  expect(outcome.lines.some((line) => line.includes('✗ scope-revert-guard') && line.includes('B.ts'))).toBe(true);
  expect(outcome.git('rev-parse', 'HEAD')).toBe(outcome.head); // ⛔ 아무것도 커밋하지 않았습니다
}, 60_000);

test('범위 밖 package.json 변경도 착지 전 차단한다', async () => {
  const outcome = await landOnRevertedScope(true, 'package.json');
  expect(outcome.code).toBe(1);
  expect(outcome.merges()).toBe(0);
  expect(outcome.lines.some((line) => line.includes('✗ scope-revert-guard') && line.includes('package.json'))).toBe(true);
  expect(outcome.git('rev-parse', 'HEAD')).toBe(outcome.head);
}, 60_000);

test('package.json 범위 밖 변경 없이 정상 착지한다', async () => {
  const outcome = await landOnRevertedScope(false, 'package.json');
  expect(outcome.code).toBe(0);
  expect(outcome.merges()).toBe(1);
}, 60_000);

test('PR 범위 밖 버전 하향은 커밋 전 차단한다', async () => {
  const outcome = await landOnRevertedScope(true, 'package.json', { downgrade: true });
  expect(outcome.git('show', 'HEAD:package.json')).toContain('1.1.0');
  expect(outcome.git('show', ':package.json')).toContain('1.0.0');
  expect(outcome.code).toBe(1);
  expect(outcome.merges()).toBe(0);
  expect(outcome.lines.some((line) => line.includes('✗ scope-revert-guard') && line.includes('package.json'))).toBe(true);
  expect(outcome.git('rev-parse', 'HEAD')).toBe(outcome.head);
}, 60_000);

test('PR에 포함된 의도적 버전 변경은 차단하지 않는다', async () => {
  const outcome = await landOnRevertedScope(false, 'package.json', { intentional: true });
  expect(outcome.git('show', `${outcome.head}:package.json`)).toContain('1.2.0');
  expect(outcome.code).toBe(0);
  expect(outcome.merges()).toBe(1);
  expect(outcome.lines.some((line) => line.includes('✗ scope-revert-guard'))).toBe(false);
}, 60_000);

test('되돌림 없는 착지는 그대로 성립한다(양성 대칭)', async () => {
  const outcome = await landOnRevertedScope(false);
  expect(outcome.code).toBe(0);
  expect(outcome.merges()).toBe(1);
  expect(outcome.lines.some((line) => line.includes('✗ scope-revert-guard'))).toBe(false);
}, 60_000);
