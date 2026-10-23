import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { runQueuedLanding, type QueueLandingInput } from './land-queue.js';

const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
const roots: string[] = [];
const input = (): QueueLandingInput => {
  const root = mkdtempSync(join(tmpdir(), 'ta-land-queue-'));
  roots.push(root);
  return { card: 'ta-example', pr: 123, head, cwd: root, statePath: join(root, 'tasks.json'),
    reviewResult: join(root, 'review-results', `ta-example-123-${head.slice(0, 12)}.json`),
    command: '/ops/land-enqueue.sh', remote: 'node-c', entry: '/ops/bin/elanous.mjs', configDir: root };
};
// LAND-REFUSAL-EXEC — these cases pin the refusal contract; the recover@1 run has its own tests
// (src/cli/pr-land-refusal-edge.test.ts), so they skip the real unit spawn.
const noRecover = async () => ({ plan: {} as never, executed: false });
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const review = JSON.stringify({ pr: 123, headCommit: head, verdict: 'warn', reviewed: true, mustFix: [] });
const summary = { head40: head, base40: base, remoteHost: 'node-c', verdict: 'passed', exitCode: 0,
  introduced: 0, unknown: 0, preconditionUnmet: 0 };

test('exact-head review, measured remote gate, then one queue call; no merge command', async () => {
  const commands: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
  const source = input();
  const result = await runQueuedLanding(source, {
    read: (path) => path === source.reviewResult ? review : JSON.stringify(summary),
    run: async (command, args, _cwd, env) => {
      commands.push({ command, args, env });
      if (args.includes('origin/main') && args.includes('rev-parse')) return { status: 0, stdout: `${base}\n`, stderr: '' };
      if (args.includes('HEAD') && args.includes('rev-parse')) return { status: 0, stdout: `${head}\n`, stderr: '' };
      if (command === 'gh') return { status: 0, stdout: JSON.stringify({ headRefOid: head, state: 'OPEN', isDraft: false }), stderr: '' };
      return { status: 0, stdout: command === source.command ? `OK #123 head=${head.slice(0, 12)} 줄 2번째\n` : '', stderr: '' };
    },
  });
  expect(result.status).toBe(0);
  expect(commands.map((call) => call.command)).toEqual([process.execPath, process.execPath, process.execPath, process.execPath, 'gh', source.command]);
  expect(commands[3]!.args).toContain('node-c');
  expect(commands[3]!.args).toContain(base);
  expect(commands[5]!.args).toEqual(['123', source.cwd, '--review', source.reviewResult, '--expected-head', head]);
  expect(commands[5]!.env?.LAND_RR_DIR).toBe(dirname(source.reviewResult));
  expect(commands.flatMap((call) => call.args).includes('land')).toBe(false);
});

test('review mismatch or unknown must-fix stops before fetching or enqueuing', async () => {
  for (const bad of [JSON.stringify({ pr: 123, headCommit: base, verdict: 'pass', reviewed: true, mustFix: [] }),
    JSON.stringify({ pr: 123, headCommit: head, verdict: 'pass', reviewed: true, mustFix: ['real blocker'] })]) {
    let calls = 0;
    const result = await runQueuedLanding(input(), { recover: noRecover, read: () => bad, run: async () => { calls++; return { status: 0, stdout: '', stderr: '' }; } });
    expect(result.status).toBe(1);
    expect(calls).toBe(0);
  }
});

test('gate summary mismatch and queue refusal are distinct fail-closed results', async () => {
  for (const variant of ['summary', 'refused'] as const) {
    const source = input();
    let queueCalls = 0;
    const result = await runQueuedLanding(source, {
      recover: noRecover,
      read: (path) => path === source.reviewResult ? review : JSON.stringify(variant === 'summary' ? { ...summary, head40: base } : summary),
      run: async (command, args) => {
        if (args.includes('origin/main') && args.includes('rev-parse')) return { status: 0, stdout: base, stderr: '' };
        if (args.includes('HEAD') && args.includes('rev-parse')) return { status: 0, stdout: head, stderr: '' };
        if (command === 'gh') return { status: 0, stdout: JSON.stringify({ headRefOid: head, state: 'OPEN', isDraft: false }), stderr: '' };
        if (command === source.command) { queueCalls++; return { status: 1, stdout: 'REFUSE review-fail-newer', stderr: '' }; }
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(variant === 'summary' ? 'remote-changed-gate' : 'land-enqueue-refused');
    expect(queueCalls).toBe(variant === 'summary' ? 0 : 1);
  }
});

test('head changing after gate or a receipt for another head cannot record queue success', async () => {
  for (const variant of ['changed', 'receipt'] as const) {
    const source = input();
    let queueCalls = 0;
    const result = await runQueuedLanding(source, {
      recover: noRecover,
      read: (path) => path === source.reviewResult ? review : JSON.stringify(summary),
      run: async (command, args) => {
        if (args.includes('origin/main') && args.includes('rev-parse')) return { status: 0, stdout: base, stderr: '' };
        if (args.includes('HEAD') && args.includes('rev-parse')) return { status: 0, stdout: head, stderr: '' };
        if (command === 'gh') return { status: 0, stdout: JSON.stringify({ headRefOid: variant === 'changed' ? base : head, state: 'OPEN', isDraft: false }), stderr: '' };
        if (command === source.command) { queueCalls++; return { status: 0, stdout: `OK #123 head=${base.slice(0, 12)} 줄 1번째`, stderr: '' }; }
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(variant === 'changed' ? 'pr-head' : 'land-enqueue-refused');
    expect(queueCalls).toBe(variant === 'changed' ? 0 : 1);
  }
});

test('real elanous git entry fetches origin/main and checks HEAD in a temporary PR worktree before queueing', async () => {
  const source = input();
  const root = source.cwd;
  const bare = join(root, 'origin.git');
  const repo = join(root, 'repo');
  const tree = join(root, 'pr-worktree');
  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  mkdirSync(repo);
  git(root, 'init', '--bare', bare);
  git(repo, 'init', '-b', 'main');
  writeFileSync(join(repo, 'file.txt'), 'main\n');
  git(repo, 'add', 'file.txt');
  git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', 'main');
  git(repo, 'remote', 'add', 'origin', bare);
  git(repo, 'push', '-u', 'origin', 'main');
  const main = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'worktree', 'add', '-b', 'feature/pr', tree, 'main');
  writeFileSync(join(tree, 'file.txt'), 'feature\n');
  git(tree, 'add', 'file.txt');
  git(tree, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', 'feature');
  source.cwd = tree;
  source.head = git(tree, 'rev-parse', 'HEAD');
  source.entry = resolve(process.cwd(), 'bin/elanous.mjs');
  source.configDir = join(root, 'config');
  mkdirSync(source.configDir);
  mkdirSync(dirname(source.reviewResult), { recursive: true });
  writeFileSync(source.reviewResult, JSON.stringify({ pr: source.pr, headCommit: source.head,
    verdict: 'pass', reviewed: true, mustFix: [] }));
  let queueCalls = 0;
  const result = await runQueuedLanding(source, { run: async (command, args, cwd) => {
    if (command === process.execPath && args.includes('git')) {
      const actual = spawnSync(command, args, { cwd, encoding: 'utf8' });
      return { status: actual.status ?? 1, stdout: actual.stdout, stderr: actual.stderr };
    }
    if (command === process.execPath && args.includes('gate')) {
      const artifact = args[args.indexOf('--artifact-dir') + 1]!;
      writeFileSync(join(artifact, 'summary.json'), JSON.stringify({ ...summary, head40: source.head, base40: main }));
      return { status: 0, stdout: '', stderr: '' };
    }
    if (command === 'gh') return { status: 0, stdout: JSON.stringify({ headRefOid: source.head, state: 'OPEN', isDraft: false }), stderr: '' };
    queueCalls++;
    expect(args).toEqual([String(source.pr), tree, '--review', source.reviewResult, '--expected-head', source.head]);
    return { status: 0, stdout: `OK #${source.pr} head=${source.head.slice(0, 12)} 줄 1번째`, stderr: '' };
  } });
  expect(result.status).toBe(0);
  expect(git(tree, 'rev-parse', 'origin/main')).toBe(main);
  expect(queueCalls).toBe(1);
}, 30_000);
