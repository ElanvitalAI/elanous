import { expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanAndReturnChildPod, type ChildPodLease, type ChildPodReuseOperations } from './pod-child-reuse.js';

const lease: ChildPodLease = {
  workerId: 'worker-1', podUid: 'uid-1', leaseId: 'lease-1', generation: 2,
  key: { context: 'ctx', imageDigest: `sha256:${'b'.repeat(64)}`,
    lockHash: 'c'.repeat(64), architecture: 'amd64' }, sourceSha: 'a'.repeat(40),
};

function fixture(fail = '') {
  const events: string[] = [];
  const gitArgs: string[][] = [];
  const quarantineReceipts: Array<{ clean: boolean; reason: string; observedResidue: number | null }> = [];
  let available = true;
  const ops: ChildPodReuseOperations = {
    stopChildProcesses: async () => { events.push('stop'); return { remaining: fail === 'process' ? 1 : 0 }; },
    git: async (_lease, args) => {
      gitArgs.push([...args]);
      events.push(args[0]!);
      return { status: fail === args[0] ? 1 : 0,
        stdout: args[0] === 'status' ? fail === 'dirty' ? '?? residue\0' : '' : '' };
    },
    removeRunCredentials: async () => {
      events.push('revoke');
      return { remaining: fail === 'credentials' ? 1 : 0 };
    },
    returnLease: async () => { events.push('return'); },
    quarantine: async (_lease, receipt) => {
      events.push('quarantine'); available = false; quarantineReceipts.push(receipt);
    },
    observe: (event) => { events.push(event); },
  };
  return { ops, events, gitArgs, quarantineReceipts, isAvailable: () => available };
}

test('a clean child is reset, cleaned, checked, revoked, and returned in that order', async () => {
  const f = fixture();
  expect(await cleanAndReturnChildPod(lease, f.ops)).toEqual({ outcome: 'returned', reason: 'clean' });
  expect(f.events).toEqual(['stop', 'reset', 'clean', 'status', 'revoke',
    'stop', 'return-decision', 'return', 'return-decision']);
  expect(f.gitArgs).toEqual([
    ['reset', '--hard', lease.sourceSha],
    expect.arrayContaining(['clean', '-ffdx']),
    expect.arrayContaining(['status', '--porcelain', '-z']),
  ]);
  expect(f.isAvailable()).toBe(true);
});

test('a process appearing during Git cleanup prevents lease return', async () => {
  const f = fixture();
  let checks = 0;
  f.ops.stopChildProcesses = async () => { f.events.push('stop'); return { remaining: ++checks === 2 ? 1 : 0 }; };
  expect(await cleanAndReturnChildPod(lease, f.ops)).toEqual({ outcome: 'quarantined',
    reason: 'child-processes-resurfaced' });
  expect(f.events.filter(event => event === 'stop')).toHaveLength(2);
  expect(f.events).not.toContain('return');
});

test.each([
  ['process', 'child-processes-remain'],
  ['reset', 'reset-failed'],
  ['clean', 'clean-failed'],
  ['status', 'status-failed'],
  ['dirty', 'worktree-not-clean'],
  ['credentials', 'credentials-remain'],
])('%s failure revokes credentials and quarantines without return', async (failure, reason) => {
  const f = fixture(failure);
  expect(await cleanAndReturnChildPod(lease, f.ops)).toEqual({ outcome: 'quarantined', reason });
  expect(f.events).toContain('revoke');
  expect(f.events).toContain('quarantine');
  expect(f.events).not.toContain('return');
  expect(f.isAvailable()).toBe(false);
  expect(f.quarantineReceipts[0]).toMatchObject({ clean: false, reason,
    observedResidue: ['process', 'dirty', 'credentials'].includes(failure) ? 1 : null });
});

test('an invalid lease never runs Git and cannot return to the pool', async () => {
  const f = fixture();
  expect(await cleanAndReturnChildPod({ ...lease, sourceSha: 'main' }, f.ops))
    .toEqual({ outcome: 'quarantined', reason: 'invalid-lease' });
  expect(f.gitArgs).toEqual([]);
  expect(f.events).not.toContain('return');
  const badKey = fixture();
  expect(await cleanAndReturnChildPod({ ...lease,
    key: { ...lease.key, imageDigest: 'mutable:latest' } }, badKey.ops))
    .toEqual({ outcome: 'quarantined', reason: 'invalid-lease' });
  expect(badKey.gitArgs).toEqual([]);
  expect(badKey.events).not.toContain('return');
});

test('an unavailable decision ledger prevents return and quarantines the otherwise clean worker', async () => {
  const f = fixture();
  f.ops.observe = (event, data) => {
    if (event === 'return-decision' && data.outcome === 'eligible') throw new Error('ledger unavailable');
    f.events.push(event);
  };
  expect(await cleanAndReturnChildPod(lease, f.ops)).toEqual({ outcome: 'quarantined',
    reason: 'return-or-observation-error:ledger unavailable' });
  expect(f.events).not.toContain('return');
  expect(f.events).toContain('quarantine');
});

test('one worker runs two rounds; real Git, child process and credential residue are zero before each return', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'si-reuse-child-'));
  const credentialDir = mkdtempSync(join(tmpdir(), 'si-reuse-cred-'));
  const credentialPath = join(credentialDir, 'run-credential');
  const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  const git = (args: readonly string[]) => spawnSync('git', [...args],
    { cwd: repo, encoding: 'utf8', env: gitEnv });
  const run = (args: readonly string[]) => {
    const result = git(args);
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout;
  };
  let child: ReturnType<typeof spawn> | null = null;
  try {
    run(['init', '-q']);
    writeFileSync(join(repo, 'tracked.txt'), 'base\n');
    run(['add', 'tracked.txt']);
    run(['-c', 'user.name=UX', '-c', 'user.email=ux@example.invalid', 'commit', '-qm', 'base']);
    const sourceSha = run(['rev-parse', 'HEAD']).trim();
    const returned: number[] = [];
    const ops: ChildPodReuseOperations = {
      stopChildProcesses: async () => {
        if (child && child.exitCode === null) {
          const exited = new Promise<void>((resolve) => child!.once('exit', () => resolve()));
          child.kill('SIGTERM');
          await exited;
        }
        const remaining = child && child.exitCode === null && child.signalCode === null ? 1 : 0;
        child = null;
        return { remaining };
      },
      git: async (_lease, args) => {
        const result = git(args);
        return { status: result.status, stdout: result.stdout };
      },
      removeRunCredentials: async () => {
        rmSync(credentialPath, { force: true });
        return { remaining: existsSync(credentialPath) ? 1 : 0 };
      },
      returnLease: async (_lease, receipt) => {
        expect(receipt).toEqual({ clean: true, reason: 'clean', observedResidue: 0 });
        expect(run(['status', '--porcelain'])).toBe('');
        expect(existsSync(credentialPath)).toBe(false);
        returned.push(1);
      },
      quarantine: async () => { throw new Error('clean worker must not quarantine'); },
      observe: () => {},
    };
    for (let round = 1; round <= 2; round++) {
      writeFileSync(join(repo, 'tracked.txt'), `round ${round}\n`);
      writeFileSync(join(repo, `untracked-${round}`), 'residue');
      writeFileSync(credentialPath, 'secret');
      child = spawn('sleep', ['30'], { stdio: 'ignore' });
      expect(await cleanAndReturnChildPod({ ...lease, sourceSha }, ops))
        .toEqual({ outcome: 'returned', reason: 'clean' });
      expect(existsSync(join(repo, `untracked-${round}`))).toBe(false);
      expect(run(['show', 'HEAD:tracked.txt'])).toBe('base\n');
    }
    expect(returned).toHaveLength(2);
  } finally {
    child?.kill('SIGKILL');
    rmSync(repo, { recursive: true, force: true });
    rmSync(credentialDir, { recursive: true, force: true });
  }
});
