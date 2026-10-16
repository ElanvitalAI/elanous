import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handTask, nextMoveFor, readTaskCard } from './task-hand.js';
import { inspectPrelaunchAlreadyDone, parseAlreadyDoneCommand, runPinnedGit, type PinnedGitResult } from './prelaunch-already-done.js';

const request = ['완료 경계 코드: 기존 추적 파일 src/task-agent/sample.ts', '완료 경계 실물: 원격 main의 일반 파일로 존재',
  '완료 경계 증거 명령: test -f src/task-agent/sample.ts'].join('\n');

test('prelaunch accepts only bounded read-only argv and repository paths', () => {
  expect(parseAlreadyDoneCommand('test -f src/a.ts')?.argv).toEqual(['test', '-f', 'src/a.ts']);
  expect(parseAlreadyDoneCommand('test -e src/a.ts')?.path).toBe('src/a.ts');
  expect(parseAlreadyDoneCommand('git ls-files --error-unmatch -- src/a.ts')?.path).toBe('src/a.ts');
  expect(parseAlreadyDoneCommand(`git diff --quiet ${'a'.repeat(40)} HEAD -- src/a.ts`)?.path).toBe('src/a.ts');
  for (const command of ['bun test src/a.test.ts', 'test -f ../other', 'test -e /etc/passwd',
    'test -f src/a.ts; touch /tmp/marker', 'test -f $(touch /tmp/marker)',
    'git diff --quiet', 'git ls-files --error-unmatch src/a.ts',
    `git diff --quiet ${'a'.repeat(40)} HEAD -- ../other`]) {
    expect(parseAlreadyDoneCommand(command)).toBeNull();
  }
});

test('passed main evidence writes candidate and waits without issuing launch identity', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'ta-already-done-')), 'state.json');
  let launches = 0;
  const result = await handTask({ id: 'ta-already-done-sample', text: request, statePath: path, live: true,
    launcher: () => { launches++; },
    prelaunchInspector: () => ({ reason: 'evidence-passed-on-main', candidate: {
      mainSha: 'a'.repeat(40), repository: 'https://github.com/example/repo.git',
      command: 'test -f src/task-agent/sample.ts', exitCode: 0,
    } }), });
  expect(launches).toBe(0);
  expect(result.launched).toBe(false);
  expect(result.move.kind).toBe('wait');
  expect(result.card.status).toBe('handed');
  expect(result.card.runId).toBeUndefined();
  expect(result.card.launchId).toBeUndefined();
  expect(result.card.greenProposal).toBeUndefined();
  expect(readTaskCard(result.card.id, path)?.alreadyDoneCandidate?.mainSha).toBe('a'.repeat(40));
  expect(nextMoveFor(result.card).kind).toBe('wait');
});

test('absent or failed evidence retains the normal live launcher', async () => {
  for (const reason of ['boundary-missing:완료 경계 증거 명령', 'evidence-not-passing', 'main-unverified-or-stale', 'evidence-command-unsupported']) {
    const path = join(mkdtempSync(join(tmpdir(), 'ta-already-done-fallback-')), 'state.json');
    let launches = 0;
    const result = await handTask({ text: request, statePath: path, live: true,
      launcher: () => { launches++; }, prelaunchInspector: () => ({ reason }) });
    expect(launches).toBe(1);
    expect(result.launched).toBe(true);
    expect(result.card.alreadyDoneCandidate).toBeUndefined();
  }
});

test('pinned main tree proof requires remote freshness twice and a tracked regular file', () => {
  const sha = 'a'.repeat(40);
  let remoteReads = 0;
  const calls: string[] = [];
  const runGit = (_cwd: string, argv: string[]): PinnedGitResult => {
    calls.push(argv.join(' '));
    if (argv[0] === 'rev-parse' && argv[1] === '--show-toplevel') return { status: 0, stdout: '/repo\n', error: false };
    if (argv[0] === 'remote') return { status: 0, stdout: 'git@github.com:example/repo.git\n', error: false };
    if (argv[0] === 'rev-parse') return { status: 0, stdout: `${sha}\n`, error: false };
    if (argv[0] === 'ls-remote') { remoteReads++; return { status: 0, stdout: `${sha}\trefs/heads/main\n`, error: false }; }
    if (argv[0] === 'ls-tree') return { status: 0, stdout: `100644 blob ${'b'.repeat(40)}\tsrc/task-agent/sample.ts\n`, error: false };
    throw new Error(`unexpected ${argv.join(' ')}`);
  };
  const decision = inspectPrelaunchAlreadyDone(request, '/repo', { realpath: () => '/repo', runGit });
  expect(decision.candidate).toMatchObject({ mainSha: sha, repository: 'example/repo', exitCode: 0 });
  expect(remoteReads).toBe(2);
  expect(calls).toContain(`ls-tree ${sha} -- src/task-agent/sample.ts`);
  expect(calls.every((call) => !/worktree|checkout|sh -c/.test(call))).toBe(true);
});

test('live hand uses the production verifier against a temporary bare remote and records the pinned main SHA', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ta-already-done-live-'));
  const remote = join(root, 'remote.git');
  const repo = join(root, 'repo');
  execFileSync('git', ['init', '--bare', '-q', remote]);
  execFileSync('git', ['init', '-b', 'main', '-q', repo]);
  execFileSync('git', ['config', 'user.name', 'UX Test'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'ux-test@example.invalid'], { cwd: repo });
  mkdirSync(join(repo, 'src', 'task-agent'), { recursive: true });
  writeFileSync(join(repo, 'src', 'task-agent', 'sample.ts'), 'export {};\n');
  execFileSync('git', ['add', 'src/task-agent/sample.ts'], { cwd: repo });
  execFileSync('git', ['commit', '-m', 'add tracked sample', '-q'], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: repo });
  execFileSync('git', ['push', '-u', 'origin', 'main', '-q'], { cwd: repo });
  execFileSync('git', ['fetch', 'origin', 'main:refs/remotes/origin/main', '-q'], { cwd: repo });
  const sha = execFileSync('git', ['rev-parse', 'refs/remotes/origin/main'], { cwd: repo, encoding: 'utf8' }).trim();

  // Production keeps rejecting local origin URLs. The seam only gives this test a GitHub identity
  // and routes ls-remote to the real temporary bare repository; all tree/path checks run through git.
  let launchesWithoutRunner = 0;
  const rejected = await handTask({ id: 'ta-already-done-local-rejected', text: request, project: { id: 'temp', target: repo },
    completion: 'code-pr', live: true, statePath: join(root, 'rejected.json'), launcher: () => { launchesWithoutRunner++; } });
  expect(launchesWithoutRunner).toBe(1);
  expect(rejected.card.alreadyDoneCandidate).toBeUndefined();

  const runner = (_cwd: string, argv: string[], timeout?: number): PinnedGitResult => {
    if (argv[0] === 'remote' && argv[1] === 'get-url')
      return { status: 0, stdout: 'https://github.com/example/repo.git\n', error: false };
    const actual = argv[0] === 'ls-remote' ? ['ls-remote', remote, ...argv.slice(2)] : argv;
    return runPinnedGit(repo, actual, timeout);
  };
  let launches = 0;
  const result = await handTask({ id: 'ta-already-done-local-verified', text: request,
    project: { id: 'temp', target: repo }, completion: 'code-pr', live: true,
    statePath: join(root, 'verified.json'), launcher: () => { launches++; }, prelaunchGitRunnerForTest: runner });
  expect(launches).toBe(0);
  expect(result.launched).toBe(false);
  expect(result.card.alreadyDoneCandidate).toMatchObject({ mainSha: sha, command: 'test -f src/task-agent/sample.ts', exitCode: 0 });
  expect(result.move.reason).toContain(`main ${sha.slice(0, 12)} (검사 시점)`);
});

test('implementation boundaries cannot be satisfied by an existing-file check', () => {
  const implementation = ['완료 경계 코드: src/task-agent/sample.ts 구현', '완료 경계 실물: 기존 사용 경로 확인',
    '완료 경계 증거 명령: test -f src/task-agent/sample.ts'].join('\n');
  expect(inspectPrelaunchAlreadyDone(implementation, '/repo', { realpath: () => '/repo', runGit: () => {
    throw new Error('mismatched boundary must be rejected before Git calls');
  } }).reason).toBe('evidence-boundary-not-file-existence');
});

test('pinned git ignores replace refs so a local replacement cannot invent a main file', () => {
  const root = mkdtempSync(join(tmpdir(), 'ta-already-done-replace-'));
  const repo = join(root, 'repo');
  execFileSync('git', ['init', '-b', 'main', '-q', repo]);
  execFileSync('git', ['config', 'user.name', 'UX Test'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'ux-test@example.invalid'], { cwd: repo });
  writeFileSync(join(repo, 'README.md'), 'base\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repo });
  execFileSync('git', ['commit', '-m', 'base', '-q'], { cwd: repo });
  const mainSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'invented.ts'), 'export {};\n');
  execFileSync('git', ['add', 'src/invented.ts'], { cwd: repo });
  execFileSync('git', ['commit', '-m', 'replacement only', '-q'], { cwd: repo });
  execFileSync('git', ['replace', mainSha, 'HEAD'], { cwd: repo });
  const replacedView = spawnSync('git', ['ls-tree', mainSha, '--', 'src/invented.ts'], { cwd: repo, encoding: 'utf8' });
  expect(replacedView.stdout).toContain('src/invented.ts');
  const pinnedView = runPinnedGit(repo, ['ls-tree', mainSha, '--', 'src/invented.ts']);
  expect(pinnedView.stdout).not.toContain('src/invented.ts');
  expect(pinnedView.status).toBe(0);
});

test('pinned git clears configured credential helpers before any credential lookup', () => {
  const root = mkdtempSync(join(tmpdir(), 'ta-already-done-credential-'));
  const repo = join(root, 'repo');
  const marker = join(root, 'helper-ran');
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['config', 'credential.helper', `!touch ${marker}`], { cwd: repo });
  const result = runPinnedGit(repo, ['credential', 'fill'], 2_000, 'protocol=https\nhost=example.invalid\n\n');
  expect(result.status).not.toBe(0);
  expect(existsSync(marker)).toBe(false);
});

test('stale main and symlink evidence preserve the live path', () => {
  const sha = 'a'.repeat(40);
  const base = (_cwd: string, argv: string[]): PinnedGitResult => {
    if (argv[0] === 'rev-parse' && argv[1] === '--show-toplevel') return { status: 0, stdout: '/repo\n', error: false };
    if (argv[0] === 'remote') return { status: 0, stdout: 'git@github.com:example/repo.git\n', error: false };
    if (argv[0] === 'rev-parse') return { status: 0, stdout: `${sha}\n`, error: false };
    if (argv[0] === 'ls-remote') return { status: 0, stdout: `${sha}\trefs/heads/main\n`, error: false };
    if (argv[0] === 'ls-tree') return { status: 0, stdout: `120000 blob ${'b'.repeat(40)}\tsrc/task-agent/sample.ts\n`, error: false };
    throw new Error(`unexpected ${argv.join(' ')}`);
  };
  expect(inspectPrelaunchAlreadyDone(request, '/repo', { realpath: () => '/repo', runGit: base }).reason).toBe('evidence-symlink-unmeasured');
  expect(inspectPrelaunchAlreadyDone(request, '/repo', { realpath: () => '/repo', runGit: (cwd, argv) =>
    argv[0] === 'rev-parse' && argv[1] !== '--show-toplevel'
      ? { status: 0, stdout: `${'c'.repeat(40)}\n`, error: false } : base(cwd, argv),
  }).reason).toBe('main-unverified-or-stale');
});
