import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runPrLandRemoteGit, type PrLandRemoteGitInput } from './pr-land-remote-git.js';
import type { CmdRunner } from '../autopilot/pr-manager.js';
import type { GateRemoteRunner } from '../self-implement/gate-remote.js';

const input: PrLandRemoteGitInput = { pr: 123, repository: 'ElanvitalAI/elanous',
  baseRepository: 'ElanvitalAI/elanous', headRef: 'refs/heads/feature/topic', head: 'a'.repeat(40), main: 'b'.repeat(40), host: 'node-b', cwd: '/repo' };

function rig(options: { changedPhase?: string; changedHead?: boolean; failPhase?: string;
  observedHead?: string; cleanupFailure?: boolean; headRef?: string } = {}) {
  const dispatched: string[] = [];
  const git: string[][] = [];
  const ssh: GateRemoteRunner['ssh'] = (_host, script) => {
    if (script.includes('rm -rf --')) {
      dispatched.push('cleanup');
      return { rc: options.cleanupFailure ? 1 : 0, stdout: '', stderr: '' };
    }
    const phase = /"phase":"(fetch|worktree|rebase|push)"/u.exec(script)?.[1] ?? 'unknown';
    dispatched.push(phase);
    if (phase === options.failPhase) return { rc: 255, stdout: '', stderr: 'ssh unavailable' };
    const receipt = { schema: 2, pr: input.pr, repository: input.repository,
      baseRepository: input.baseRepository, headRef: options.headRef ?? input.headRef, head: input.head, main: input.main, host: input.host,
      phase: phase === options.changedPhase ? 'push' : phase, ok: true,
      resultHead: phase === 'rebase' && options.changedHead ? 'c'.repeat(40) : input.head,
      mergeSha: input.main };
    return { rc: 0, stdout: `${JSON.stringify(receipt)}\n`, stderr: '' };
  };
  const run: CmdRunner = (cmd, args) => {
    git.push([cmd, ...args]);
    return { ok: true, out: options.observedHead ?? input.head, err: '' };
  };
  return { dispatched, git, ssh, run };
}

test('remote Git validates four phase receipts, then HQ verifies the exact source ref', () => {
  const deps = rig();
  expect(runPrLandRemoteGit(input, deps)).toEqual({ ok: true, resultHead: input.head, host: input.host });
  expect(deps.dispatched).toEqual(['fetch', 'worktree', 'rebase', 'push', 'cleanup']);
  expect(deps.git).toEqual([['gh', 'api', 'repos/ElanvitalAI/elanous/git/ref/heads/feature/topic', '--jq', '.object.sha']]);
});

test('source refs containing a hash are encoded before authenticated API lookup', () => {
  const special = { ...input, headRef: 'refs/heads/feature/hash#topic' };
  const deps = rig({ headRef: special.headRef });
  expect(runPrLandRemoteGit(special, deps)).toEqual({ ok: true, resultHead: input.head, host: input.host });
  expect(deps.git).toContainEqual(['gh', 'api', 'repos/ElanvitalAI/elanous/git/ref/heads/feature/hash%23topic', '--jq', '.object.sha']);
});

test('identity mismatch stops before worktree and never falls back to local Git', () => {
  const deps = rig({ changedPhase: 'fetch' });
  expect(runPrLandRemoteGit(input, deps)).toMatchObject({ ok: false, reason: 'receipt-identity-mismatch' });
  expect(deps.dispatched).toEqual(['fetch', 'cleanup']);
  expect(deps.git).toEqual([]);
});

test('changed reviewed head stops before push', () => {
  const deps = rig({ changedHead: true });
  expect(runPrLandRemoteGit(input, deps)).toMatchObject({ ok: false, reason: 'remote-git-rebase-changed-reviewed-head' });
  expect(deps.dispatched).toEqual(['fetch', 'worktree', 'rebase', 'cleanup']);
});

test('transport failure has no local fallback and cleans scratch', () => {
  const deps = rig({ failPhase: 'worktree' });
  expect(runPrLandRemoteGit(input, deps)).toMatchObject({ ok: false, reason: expect.stringContaining('remote-git-worktree-failed') });
  expect(deps.dispatched).toEqual(['fetch', 'worktree', 'cleanup']);
  expect(deps.git).toEqual([]);
});

test('HQ rejects a post-push ref mismatch and cleanup failure', () => {
  const mismatch = rig({ observedHead: 'c'.repeat(40) });
  expect(runPrLandRemoteGit(input, mismatch)).toMatchObject({ ok: false, reason: 'post-push-head-mismatch' });
  const cleanup = rig({ cleanupFailure: true });
  expect(runPrLandRemoteGit(input, cleanup)).toMatchObject({ ok: false, reason: 'remote-git-cleanup-unmeasured' });
});

test('fork simulation fetches the head from its source and pinned main from the base repository', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'pr-land-remote-sim-'));
  const repo = join(scratch, 'source');
  const sourceBare = join(scratch, 'fork.git');
  const baseBare = join(scratch, 'base.git');
  const git = (args: string[], cwd = repo) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  try {
    const init = spawnSync('git', ['init', '-q', repo]);
    expect(init.status).toBe(0);
    git(['config', 'user.name', 'Remote Sim']);
    git(['config', 'user.email', 'remote@example.test']);
    git(['commit', '--allow-empty', '-qm', 'main']);
    const main = git(['rev-parse', 'HEAD']);
    git(['branch', '-M', 'main']);
    git(['checkout', '-qb', 'feature/topic']);
    git(['commit', '--allow-empty', '-qm', 'feature']);
    const head = git(['rev-parse', 'HEAD']);
    expect(spawnSync('git', ['init', '--bare', '-q', sourceBare]).status).toBe(0);
    expect(spawnSync('git', ['init', '--bare', '-q', baseBare]).status).toBe(0);
    git(['remote', 'add', 'origin', sourceBare]);
    git(['push', '-q', sourceBare, 'feature/topic']);
    git(['push', '-q', baseBare, 'main']);
    const sample = { ...input, repository: 'contributor/elanous-agent', baseRepository: 'ElanvitalAI/elanous', head, main, cwd: repo };
    let hqGitProcesses = 0;
    let workerGitPhases = 0;
    const ssh: GateRemoteRunner['ssh'] = (_host, script) => {
      if (!script.includes('rm -rf --')) workerGitPhases++;
      const localScript = script
        .replaceAll('git@github.com:contributor/elanous-agent.git', sourceBare)
        .replaceAll('https://github.com/ElanvitalAI/elanous.git', baseBare);
      // Source: #35917 follows docker/harness/build.test.ts 20s bound for subprocess-based hermetic tests.
      const output = spawnSync('sh', ['-s'], { input: localScript, encoding: 'utf8', timeout: 20_000 });
      return { rc: output.status, stdout: output.stdout, stderr: output.stderr };
    };
    const run: CmdRunner = (cmd, args) => {
      hqGitProcesses++;
      expect(cmd).toBe('gh');
      expect(args).toEqual(['api', 'repos/contributor/elanous-agent/git/ref/heads/feature/topic', '--jq', '.object.sha']);
      const out = git(['ls-remote', '--heads', sourceBare, sample.headRef]).split(/\s+/u)[0] ?? '';
      return { ok: /^[a-f0-9]{40}$/iu.test(out), out, err: '' };
    };
    const before = hqGitProcesses;
    expect(runPrLandRemoteGit(sample, { ssh, run })).toEqual({ ok: true, resultHead: head, host: 'node-b' });
    const after = hqGitProcesses;
    expect({ before, after, workerGitPhases }).toEqual({ before: 0, after: 1, workerGitPhases: 4 });
    expect(git(['ls-remote', '--heads', sourceBare, sample.headRef]).split(/\s+/u)[0]).toBe(head);
    expect(git(['ls-remote', '--heads', sourceBare, 'refs/heads/main'])).toBe('');
    expect(git(['ls-remote', '--heads', baseBare, 'refs/heads/main']).split(/\s+/u)[0]).toBe(main);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
