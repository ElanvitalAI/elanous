import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stateDirSourceForChild } from '../../agent/identity-env.js';
import { debug } from '../../debug/log.js';
import type { WarmWorkerCommand } from './pod-warm-worker-protocol.js';
import { warmWorkerSourceMatches, WarmWorkerRuntime, type WarmWorkerRunFile } from './pod-warm-worker-runtime.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const file = 'src/example/worker.test.ts';
const key = { context: 'node-b', imageDigest: `sha256:${'b'.repeat(64)}`, lockHash: 'c'.repeat(64), architecture: 'amd64' };
const command = (cutSha: string, lockHash: string, attemptId: string): WarmWorkerCommand => ({
  protocol: 1, runId: 'run-1', attemptId, cutSha, leaseId: 'lease-1',
  generation: 1, workerId: 'worker-1', key: { ...key, lockHash }, deadlineAt: Date.now() + 60_000,
  files: [file], envProfile: 'gate-v1',
});
function root(parentDir?: string) {
  const dir = mkdtempSync(join(parentDir ?? tmpdir(), 'warm-runtime-'));
  roots.push(dir);
  mkdirSync(join(dir, 'src/example'), { recursive: true });
  writeFileSync(join(dir, file), 'test(() => {})');
  writeFileSync(join(dir, 'bun.lock'), 'pinned-lock');
  for (const args of [['init', '-q'], ['add', '--', file, 'bun.lock'],
    ['-c', 'user.name=TC', '-c', 'user.email=tc@example.test', 'commit', '-qm', 'fixture']]) {
    const result = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
  }
  const cutSha = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  const lockHash = createHash('sha256').update('pinned-lock').digest('hex');
  return { repoDir: dir, scratchDir: join(dir, 'scratch[1]'), artifactsRoot: join(dir, 'artifacts[1]'), workerId: 'worker-1',
    request: (attemptId: string) => command(cutSha, lockHash, attemptId) };
}
function complete(request: WarmWorkerRunFile) {
  writeFileSync(request.junitPath,
    `<testsuites tests="1"><testsuite name="${file}" file="${file}" tests="1"><testcase name="works" file="${file}"/></testsuite></testsuites>`);
  const digest = createHash('sha256').update(readFileSync(request.junitPath)).digest('hex');
  writeFileSync(request.logPath, `[warm-worker] file=${request.file}\n[warm-worker] cut=${request.cutSha} attempt=${request.attemptId}\nbun test v1.4.2\n${request.file}:\n(pass) works\n1 pass\n0 fail\n0 errors\nRan 1 test across 1 file.\n[warm-worker] junit-sha256=${digest}\n`);
}

test('two commands execute sequentially with distinct private HOME/state/tmp/XDG directories and artifact namespaces', async () => {
  const options = root();
  const seen: WarmWorkerRunFile[] = [];
  let active = 0;
  const runtime = new WarmWorkerRuntime({ ...options, runFile: async request => {
    expect(active++).toBe(0);
    expect(request.env.ELANOUS_STATE_DIR_SOURCE).toBe(stateDirSourceForChild(request.env.ELANOUS_STATE_DIR!));
    expect(request.env.ELANOUS_STATE_DIR_SOURCE).toBe('explicit');
    if (seen.length) {
      expect(existsSync(seen[0]!.env.HOME!)).toBe(false);
      expect(request.env.HOME).not.toBe(seen[0]!.env.HOME);
      expect(request.env.ELANOUS_STATE_DIR).not.toBe(seen[0]!.env.ELANOUS_STATE_DIR);
      expect(request.env.TMPDIR).not.toBe(seen[0]!.env.TMPDIR);
      for (const name of ['XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR'])
        expect(request.env[name]).not.toBe(seen[0]!.env[name]);
      expect(request.logPath).not.toBe(seen[0]!.logPath);
    }
    seen.push(request);
    writeFileSync(join(request.env.HOME!, 'token'), 'first-request-only');
    await new Promise(done => setTimeout(done, 5));
    complete(request);
    active--;
    return 0;
  } });
  const [first, second] = await Promise.all([runtime.handle(options.request('attempt-1')), runtime.handle(options.request('attempt-2'))]);
  expect(first.reason).toBe('complete');
  expect(second.reason).toBe('complete');
  expect(first.reply?.files).toEqual([{ file, rc: 0, failureIds: [], errorIds: [], junitComplete: true }]);
  expect(second.reply?.files).toEqual(first.reply?.files);
  expect(first.artifactsDir).not.toBe(second.artifactsDir);
  expect(existsSync(join(first.artifactsDir!, 'reply.json'))).toBe(true);
  expect(JSON.parse(readFileSync(join(second.artifactsDir!, 'reply.json'), 'utf8')).attemptId).toBe('attempt-2');
  expect(existsSync(options.scratchDir)).toBe(true);
  const prefix = join(second.artifactsDir!, 'file-0');
  const manifest = JSON.parse(readFileSync(`${prefix}.warm-manifest.json`, 'utf8'));
  expect(manifest).toMatchObject({ protocol: 1, file, cutSha: options.request('attempt-2').cutSha, attemptId: 'attempt-2', rc: 0 });
  expect(manifest.logSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(manifest.junitSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(existsSync(seen[1]!.env.HOME!)).toBe(false);
});

test('cleans each request back to its pinned base before the next request', async () => {
  const options = root();
  const artifact = join(options.repoDir, 'previous-request.tmp');
  let calls = 0;
  const runtime = new WarmWorkerRuntime({ ...options, runFile: async request => {
    calls++;
    if (calls === 1) {
      writeFileSync(artifact, 'untracked residue');
    } else {
      expect(existsSync(artifact)).toBe(false);
    }
    complete(request);
    return 0;
  } });

  expect((await runtime.handle(options.request('attempt-1'))).reason).toBe('complete');
  expect((await runtime.handle(options.request('attempt-2'))).reason).toBe('complete');
  expect(calls).toBe(2);
});

test('resets a changed HEAD at the request boundary before quarantining source drift', async () => {
  const options = root();
  const newTrackedFile = join(options.repoDir, 'src/example/next-head.ts');
  let calls = 0;
  const runtime = new WarmWorkerRuntime({ ...options, runFile: async request => {
    calls++;
    writeFileSync(newTrackedFile, 'committed by previous request');
    for (const args of [['add', '--', newTrackedFile], ['-c', 'user.name=TC', '-c', 'user.email=tc@example.test', 'commit', '-qm', 'previous request changed HEAD']]) {
      const result = spawnSync('git', ['-C', options.repoDir, ...args], { encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr);
    }
    complete(request);
    return 0;
  } });
  expect(await runtime.handle(options.request('head-drift')))
    .toMatchObject({ reply: null, quarantineWorker: true, reason: 'quarantined' });
  expect(spawnSync('git', ['-C', options.repoDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim())
    .toBe(options.request('head-drift').cutSha);
  expect(existsSync(newTrackedFile)).toBe(false);
  expect(await runtime.handle(options.request('after-head-drift')))
    .toMatchObject({ reply: null, quarantineWorker: true, reason: 'quarantined' });
  expect(calls).toBe(1);
});

test('preserves runtime files reached through an external symlink with a missing final directory', async () => {
  const options = root();
  const aliasRoot = mkdtempSync(join(tmpdir(), 'warm-runtime-external-alias-'));
  roots.push(aliasRoot);
  const alias = join(aliasRoot, 'checkout');
  symlinkSync(options.repoDir, alias);
  const scratchDir = join(alias, 'scratch[1]');
  const persistent = join(options.repoDir, 'scratch[1]', 'external-alias-residue.txt');
  let calls = 0;
  const runtime = new WarmWorkerRuntime({ ...options, scratchDir, runFile: async request => {
    calls++;
    if (calls === 1) {
      mkdirSync(join(options.repoDir, 'scratch[1]'), { recursive: true });
      writeFileSync(persistent, 'must survive request cleanup');
    } else {
      expect(readFileSync(persistent, 'utf8')).toBe('must survive request cleanup');
    }
    complete(request);
    return 0;
  } });
  expect((await runtime.handle(options.request('external-alias-1'))).reason).toBe('complete');
  expect((await runtime.handle(options.request('external-alias-2'))).reason).toBe('complete');
  expect(calls).toBe(2);
  expect(existsSync(persistent)).toBe(true);
});

test('a failed request-boundary git cleanup emits evidence and blocks the next request', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'warm-parent-repo-'));
  roots.push(parent);
  const parentGit = (args: string[]) => {
    const result = spawnSync('git', ['-C', parent, ...args], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
  };
  parentGit(['init', '-q']);
  parentGit(['config', 'user.name', 'warm-parent']);
  parentGit(['config', 'user.email', 'warm-parent@example.test']);
  writeFileSync(join(parent, 'parent-marker.txt'), 'outer repository');
  parentGit(['add', 'parent-marker.txt']);
  parentGit(['commit', '-qm', 'outer repository']);
  const options = root(parent);
  const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
  const original = debug.log;
  (debug as { log: typeof debug.log }).log = ((category: string, event: string, data?: unknown) => {
    events.push({ category, event, data: data as Record<string, unknown> });
  }) as typeof debug.log;
  let calls = 0;
  try {
    const runtime = new WarmWorkerRuntime({ ...options, runFile: async request => {
      calls++;
      complete(request);
      writeFileSync(join(options.repoDir, 'parent-artifact.txt'), 'must survive root loss');
      rmSync(join(options.repoDir, '.git'), { recursive: true, force: true });
      return 0;
    } });
    expect(await runtime.handle(options.request('attempt-1')))
      .toMatchObject({ reply: null, quarantineWorker: true, reason: 'cleanup-failed' });
    expect(await runtime.handle(options.request('attempt-2')))
      .toMatchObject({ reply: null, quarantineWorker: true, reason: 'quarantined' });
    expect(calls).toBe(1);
    expect(readFileSync(join(options.repoDir, 'parent-artifact.txt'), 'utf8')).toBe('must survive root loss');
    expect(events).toContainEqual({ category: 'pod.reuse', event: 'clean-failed', data: {
      runId: 'run-1', attemptId: 'attempt-1', workerId: 'worker-1', reason: 'checkout-root-mismatch', remainingPaths: [],
    } });
  } finally {
    (debug as { log: typeof debug.log }).log = original;
  }
});

test('a failed reset short-circuits before clean or status can run', async () => {
  const options = root();
  const commands: string[] = [];
  let runnerCalls = 0;
  const runtime = new WarmWorkerRuntime({ ...options,
    runGit: args => {
      commands.push(args[0]!);
      const result = spawnSync('git', ['-C', options.repoDir, ...args], { encoding: 'utf8',
        env: args[0] === 'reset' ? { ...process.env, GIT_DIR: join(options.repoDir, '.git-missing') } : process.env });
      return { status: result.status, stdout: result.stdout };
    },
    runFile: async request => { runnerCalls++; complete(request); return 0; },
  });
  expect(await runtime.handle(options.request('reset-fails')))
    .toMatchObject({ reply: null, quarantineWorker: true, reason: 'cleanup-failed' });
  expect(await runtime.handle(options.request('after-reset-fails')))
    .toMatchObject({ reply: null, quarantineWorker: true, reason: 'quarantined' });
  expect(commands).toContain('reset');
  expect(commands).not.toContain('clean');
  expect(commands).not.toContain('status');
  expect(runnerCalls).toBe(1);
});

test('a failed clean short-circuits before status and quarantines the next request', async () => {
  const options = root();
  const commands: string[] = [];
  let runnerCalls = 0;
  const runtime = new WarmWorkerRuntime({ ...options,
    runGit: args => {
      commands.push(args[0]!);
      const result = spawnSync('git', ['-C', options.repoDir, ...args], { encoding: 'utf8',
        env: args[0] === 'clean' ? { ...process.env, GIT_DIR: join(options.repoDir, '.git-missing') } : process.env });
      return { status: result.status, stdout: result.stdout };
    },
    runFile: async request => { runnerCalls++; complete(request); return 0; },
  });
  expect(await runtime.handle(options.request('clean-fails')))
    .toMatchObject({ reply: null, quarantineWorker: true, reason: 'cleanup-failed' });
  expect(await runtime.handle(options.request('after-clean-fails')))
    .toMatchObject({ reply: null, quarantineWorker: true, reason: 'quarantined' });
  expect(commands).toContain('clean');
  expect(commands).not.toContain('status');
  expect(runnerCalls).toBe(1);
});

test('rejects a checkout-local runtime path that is a symlink before running work', async () => {
  const options = root();
  const target = mkdtempSync(join(tmpdir(), 'warm-runtime-link-target-'));
  roots.push(target);
  symlinkSync(target, options.scratchDir);
  let calls = 0;
  const runtime = new WarmWorkerRuntime({ ...options, runFile: async request => { calls++; complete(request); return 0; } });
  expect(await runtime.handle(options.request('symlinked-scratch')))
    .toMatchObject({ reply: null, quarantineWorker: true, reason: 'cleanup-failed' });
  expect(calls).toBe(0);
  expect(existsSync(target)).toBe(true);
});

test('rejects a checkout-local symlink reached through an external checkout alias', async () => {
  const options = root();
  const target = mkdtempSync(join(tmpdir(), 'warm-runtime-nested-link-target-'));
  const aliasRoot = mkdtempSync(join(tmpdir(), 'warm-runtime-nested-link-alias-'));
  roots.push(target, aliasRoot);
  const alias = join(aliasRoot, 'checkout');
  symlinkSync(options.repoDir, alias);
  symlinkSync(target, join(options.repoDir, 'internal-link'));
  let calls = 0;
  const runtime = new WarmWorkerRuntime({ ...options,
    scratchDir: join(alias, 'internal-link', 'scratch'),
    runFile: async request => { calls++; complete(request); return 0; },
  });
  expect(await runtime.handle(options.request('nested-checkout-symlink')))
    .toMatchObject({ reply: null, quarantineWorker: true, reason: 'cleanup-failed' });
  expect(calls).toBe(0);
  expect(existsSync(target)).toBe(true);
});

test('rejects dot-dot paths that would normalize away a checkout-local symlink', async () => {
  const options = root();
  const target = mkdtempSync(join(tmpdir(), 'warm-runtime-dotdot-target-'));
  roots.push(target);
  symlinkSync(target, join(options.repoDir, 'internal-link'));
  let calls = 0;
  const runtime = new WarmWorkerRuntime({ ...options,
    scratchDir: `${options.repoDir}/internal-link/../scratch`,
    runFile: async request => { calls++; complete(request); return 0; },
  });
  expect(await runtime.handle(options.request('dot-dot-symlink')))
    .toMatchObject({ reply: null, quarantineWorker: true, reason: 'cleanup-failed' });
  expect(calls).toBe(0);
  expect(existsSync(target)).toBe(true);
});

test('a thrown cleanup command quarantines the worker and rejects its next request', async () => {
  const options = root();
  let calls = 0;
  const runtime = new WarmWorkerRuntime({ ...options,
    runGit: args => {
      if (args[0] === 'rev-parse') return { status: 0, stdout: options.repoDir };
      if (args[0] === 'reset') throw new Error('runner unavailable');
      return { status: 0, stdout: '' };
    },
    runFile: async request => { calls++; complete(request); return 0; },
  });
  expect(await runtime.handle(options.request('git-throws')))
    .toMatchObject({ reply: null, quarantineWorker: true, reason: 'cleanup-failed' });
  expect(await runtime.handle(options.request('after-git-throws')))
    .toMatchObject({ reply: null, quarantineWorker: true, reason: 'quarantined' });
  expect(calls).toBe(1);
});

test('missing porcelain output quarantines the worker and rejects its next request', async () => {
  const options = root();
  let calls = 0;
  const runtime = new WarmWorkerRuntime({ ...options,
    runGit: args => {
      if (args[0] === 'rev-parse') return { status: 0, stdout: options.repoDir };
      if (args[0] === 'status') return { status: 0 };
      return { status: 0, stdout: '' };
    },
    runFile: async request => { calls++; complete(request); return 0; },
  });
  expect(await runtime.handle(options.request('missing-status-output')))
    .toMatchObject({ reply: null, quarantineWorker: true, reason: 'cleanup-failed' });
  expect(await runtime.handle(options.request('after-missing-status')))
    .toMatchObject({ reply: null, quarantineWorker: true, reason: 'quarantined' });
  expect(calls).toBe(1);
});

test('cleanup observation keeps unusual residual paths exact with porcelain NUL output', async () => {
  const options = root();
  const residual = 'residue [quoted] snow ☃.txt';
  const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
  const original = debug.log;
  (debug as { log: typeof debug.log }).log = ((category: string, event: string, data?: unknown) => {
    events.push({ category, event, data: data as Record<string, unknown> });
  }) as typeof debug.log;
  let calls = 0;
  const runtime = new WarmWorkerRuntime({ ...options,
    runGit: args => {
      if (args[0] === 'rev-parse') {
        const result = spawnSync('git', ['-C', options.repoDir, ...args], { encoding: 'utf8' });
        return { status: result.status, stdout: result.stdout };
      }
      if (args[0] === 'status') writeFileSync(join(options.repoDir, residual), 'residual');
      const result = spawnSync('git', ['-C', options.repoDir, ...args], { encoding: 'utf8' });
      return { status: result.status, stdout: result.stdout };
    },
    runFile: async request => { calls++; complete(request); return 0; },
  });
  try {
    expect(await runtime.handle(options.request('nul-status-path')))
      .toMatchObject({ reply: null, quarantineWorker: true, reason: 'cleanup-failed' });
    expect(await runtime.handle(options.request('after-nul-status-path')))
      .toMatchObject({ reply: null, quarantineWorker: true, reason: 'quarantined' });
    expect(calls).toBe(1);
    expect(events.some(event => event.category === 'pod.reuse' && event.event === 'clean-failed'
      && event.data.remainingPaths instanceof Array && event.data.remainingPaths.includes(residual))).toBe(true);
  } finally {
    (debug as { log: typeof debug.log }).log = original;
  }
});

test('cleanup observation reports a NUL porcelain rename destination without its source path', async () => {
  const options = root();
  const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
  const original = debug.log;
  (debug as { log: typeof debug.log }).log = ((category: string, event: string, data?: unknown) => {
    events.push({ category, event, data: data as Record<string, unknown> });
  }) as typeof debug.log;
  const runtime = new WarmWorkerRuntime({ ...options,
    runGit: args => {
      if (args[0] === 'status') {
        const moved = spawnSync('git', ['-C', options.repoDir, 'mv', 'src/example/worker.test.ts', 'src/example/renamed test.ts'], { encoding: 'utf8' });
        if (moved.status !== 0) throw new Error(moved.stderr);
      }
      const result = spawnSync('git', ['-C', options.repoDir, ...args], { encoding: 'utf8' });
      return { status: result.status, stdout: result.stdout };
    },
    runFile: async request => { complete(request); return 0; },
  });
  try {
    expect(await runtime.handle(options.request('rename-residue')))
      .toMatchObject({ reply: null, quarantineWorker: true, reason: 'cleanup-failed' });
    const event = events.find(item => item.category === 'pod.reuse' && item.event === 'clean-failed');
    expect(event?.data.remainingPaths).toEqual(['src/example/renamed test.ts']);
  } finally {
    (debug as { log: typeof debug.log }).log = original;
  }
});

test('missing JUnit never yields a reply and the worker quarantines before another request', async () => {
  const options = root();
  let calls = 0;
  const runtime = new WarmWorkerRuntime({ ...options, runFile: async request => {
    calls++;
    writeFileSync(request.logPath, 'bun test v1.0.0\n1 pass\n0 fail\n0 errors\nRan 1 test across 1 file.');
    return 0;
  } });
  const first = await runtime.handle(options.request('attempt-1'));
  expect(first).toMatchObject({ reply: null, quarantineWorker: true, reason: 'missing-artifact' });
  expect(await runtime.handle(options.request('attempt-2'))).toMatchObject({ reply: null, reason: 'quarantined' });
  expect(calls).toBe(1);
});

test('cleanup failure marks contamination and prevents reuse even with complete test artifacts', async () => {
  const options = root();
  let calls = 0;
  const runtime = new WarmWorkerRuntime({ ...options, runFile: async request => { calls++; complete(request); return 0; },
    removeScratch: () => { throw new Error('busy mount'); } });
  expect(await runtime.handle(options.request('attempt-1'))).toMatchObject({ reply: null, quarantineWorker: true, reason: 'cleanup-failed' });
  expect(await runtime.handle(options.request('attempt-2'))).toMatchObject({ reply: null, reason: 'quarantined' });
  expect(calls).toBe(1);
});

test('invalid identity and traversal paths are refused before a runner or artifact directory is touched', async () => {
  const options = root();
  let calls = 0;
  const runtime = new WarmWorkerRuntime({ ...options, runFile: async () => { calls++; return 0; } });
  for (const bad of ['../worker.test.ts', '/tmp/worker.test.ts', 'src/../worker.test.ts', 'src\\worker.test.ts']) {
    expect(await runtime.handle({ ...options.request('attempt-1'), files: [bad] })).toMatchObject({ reason: 'invalid-command', reply: null });
  }
  expect(await runtime.handle({ ...options.request('attempt-1'), workerId: 'wrong' })).toMatchObject({ reason: 'invalid-command' });
  expect(await runtime.handle({ ...options.request('attempt-1'), attemptId: '../escape' })).toMatchObject({ reason: 'invalid-command' });
  expect(await runtime.handle({ ...options.request('attempt-1'), key: {} as WarmWorkerCommand['key'] })).toMatchObject({ reason: 'invalid-command' });
  expect(await runtime.handle({ ...options.request('attempt-1'), cutSha: 'abc' })).toMatchObject({ reason: 'invalid-command' });
  const outsideRoot = mkdtempSync(join(tmpdir(), 'warm-runtime-outside-'));
  roots.push(outsideRoot);
  const outside = join(outsideRoot, 'outside.test.ts');
  writeFileSync(outside, 'test(() => {})');
  symlinkSync(outside, join(options.repoDir, 'src/example/escape.test.ts'));
  expect(await runtime.handle({ ...options.request('attempt-1'), files: ['src/example/escape.test.ts'] })).toMatchObject({ reason: 'invalid-command' });
  expect(calls).toBe(0);
  expect(existsSync(options.artifactsRoot)).toBe(false);
});

test('untracked test file is not admitted even when it exists inside the checkout', async () => {
  const options = root();
  const untracked = 'src/example/new.test.ts';
  writeFileSync(join(options.repoDir, untracked), 'test(() => {})');
  let calls = 0;
  const runtime = new WarmWorkerRuntime({ ...options, runFile: async () => { calls++; return 0; } });
  expect(await runtime.handle({ ...options.request('untracked'), files: [untracked] }))
    .toMatchObject({ reason: 'invalid-command', reply: null });
  expect(calls).toBe(0);
});

test('tracked symlink cannot redirect a test to untracked bytes', async () => {
  const options = root();
  const untracked = 'src/example/new.test.ts';
  const linked = 'src/example/linked.test.ts';
  writeFileSync(join(options.repoDir, untracked), 'test(() => {})');
  symlinkSync('new.test.ts', join(options.repoDir, linked));
  const added = spawnSync('git', ['-C', options.repoDir, 'add', '--', linked], { encoding: 'utf8' });
  if (added.status !== 0) throw new Error(added.stderr);
  let calls = 0;
  const runtime = new WarmWorkerRuntime({ ...options, runFile: async () => { calls++; return 0; } });
  expect(await runtime.handle({ ...options.request('linked'), files: [linked] }))
    .toMatchObject({ reason: 'quarantined', reply: null });
  expect(calls).toBe(0);
});

test('a valid request expired while queued quarantines the worker', async () => {
  const options = root();
  let clock = 1_000;
  let unblock!: () => void;
  const paused = new Promise<void>(resolve => { unblock = resolve; });
  const runtime = new WarmWorkerRuntime({ ...options, now: () => clock,
    runFile: async request => { await paused; complete(request); return 0; } });
  const first = runtime.handle({ ...options.request('first'), deadlineAt: 2_000 });
  const second = runtime.handle({ ...options.request('queued'), deadlineAt: 1_500 });
  await new Promise(resolve => setTimeout(resolve, 10));
  clock = 1_600;
  unblock();
  expect((await first).reason).toBe('complete');
  expect(await second).toMatchObject({ reply: null, quarantineWorker: true, reason: 'execution-error' });
  expect(await runtime.handle({ ...options.request('later'), deadlineAt: 3_000 })).toMatchObject({ reason: 'quarantined' });
});

test('hidden index flags cannot conceal changed source bytes', () => {
  const options = root();
  const head = options.request('source').cutSha;
  const lockHash = options.request('source').key.lockHash;
  expect(warmWorkerSourceMatches(options.repoDir, head, lockHash)).toBe(true);
  for (const flag of ['--assume-unchanged', '--skip-worktree']) {
    const result = spawnSync('git', ['-C', options.repoDir, 'update-index', flag, '--', file], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    writeFileSync(join(options.repoDir, file), `changed-${flag}`);
    expect(warmWorkerSourceMatches(options.repoDir, head, lockHash)).toBe(false);
    spawnSync('git', ['-C', options.repoDir, 'update-index', '--no-assume-unchanged', '--no-skip-worktree', '--', file]);
    writeFileSync(join(options.repoDir, file), 'test(() => {})');
  }
});

test('inherited Git checkout overrides cannot validate different dirty source bytes', async () => {
  const options = root();
  const clean = mkdtempSync(join(tmpdir(), 'warm-clean-git-'));
  roots.push(clean);
  const clone = spawnSync('git', ['clone', '-q', options.repoDir, clean], { encoding: 'utf8' });
  if (clone.status !== 0) throw new Error(clone.stderr);
  writeFileSync(join(options.repoDir, file), 'changed source bytes');
  const previous = { dir: process.env.GIT_DIR, tree: process.env.GIT_WORK_TREE,
    index: process.env.GIT_INDEX_FILE, objects: process.env.GIT_OBJECT_DIRECTORY };
  try {
    process.env.GIT_DIR = join(clean, '.git');
    process.env.GIT_WORK_TREE = clean;
    process.env.GIT_INDEX_FILE = join(clean, '.git/index');
    process.env.GIT_OBJECT_DIRECTORY = join(clean, '.git/objects');
    const request = options.request('foreign-git');
    expect(warmWorkerSourceMatches(options.repoDir, request.cutSha, request.key.lockHash)).toBe(false);
    let calls = 0;
    const runtime = new WarmWorkerRuntime({ ...options, runFile: async () => { calls++; return 0; } });
    expect(await runtime.handle(request)).toMatchObject({ reply: null, quarantineWorker: true, reason: 'quarantined' });
    expect(calls).toBe(0);
  } finally {
    for (const [name, value] of Object.entries({ GIT_DIR: previous.dir, GIT_WORK_TREE: previous.tree,
      GIT_INDEX_FILE: previous.index, GIT_OBJECT_DIRECTORY: previous.objects })) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});

test('the file runner observes the pinned checkout even with inherited Git overrides', async () => {
  const options = root();
  const clean = mkdtempSync(join(tmpdir(), 'warm-other-git-'));
  roots.push(clean);
  const clone = spawnSync('git', ['clone', '-q', options.repoDir, clean], { encoding: 'utf8' });
  if (clone.status !== 0) throw new Error(clone.stderr);
  const previous = { dir: process.env.GIT_DIR, tree: process.env.GIT_WORK_TREE,
    index: process.env.GIT_INDEX_FILE, objects: process.env.GIT_OBJECT_DIRECTORY };
  try {
    process.env.GIT_DIR = join(clean, '.git');
    process.env.GIT_WORK_TREE = clean;
    process.env.GIT_INDEX_FILE = join(clean, '.git/index');
    process.env.GIT_OBJECT_DIRECTORY = join(clean, '.git/objects');
    const runtime = new WarmWorkerRuntime({ ...options, runFile: async request => {
      expect(Object.keys(request.env).filter(name => name.startsWith('GIT_'))).toEqual([]);
      const git = (args: string[]) => spawnSync('git', ['-C', request.cwd, ...args],
        { encoding: 'utf8', env: request.env });
      expect(realpathSync(git(['rev-parse', '--show-toplevel']).stdout.trim())).toBe(realpathSync(options.repoDir));
      expect(git(['rev-parse', 'HEAD']).stdout.trim()).toBe(request.cutSha);
      complete(request);
      return 0;
    } });
    expect((await runtime.handle(options.request('runner-git'))).reason).toBe('complete');
  } finally {
    for (const [name, value] of Object.entries({ GIT_DIR: previous.dir, GIT_WORK_TREE: previous.tree,
      GIT_INDEX_FILE: previous.index, GIT_OBJECT_DIRECTORY: previous.objects })) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});

test('a command that expires during execution cannot produce a measured reply', async () => {
  const options = root();
  let clock = 1_000;
  const runtime = new WarmWorkerRuntime({ ...options, now: () => clock, runFile: async request => {
    complete(request);
    clock = 2_000;
    return 0;
  } });
  expect(await runtime.handle({ ...options.request('attempt-1'), deadlineAt: 1_500 }))
    .toMatchObject({ reply: null, quarantineWorker: true, reason: 'execution-error' });
  expect(await runtime.handle({ ...options.request('attempt-2'), deadlineAt: 3_000 })).toMatchObject({ reason: 'quarantined' });
});

test('tracked source changed during a successful file run is reset but the reply is refused', async () => {
  const options = root();
  const runtime = new WarmWorkerRuntime({ ...options, runFile: async request => {
    complete(request);
    writeFileSync(join(options.repoDir, file), 'changed while test ran');
    return 0;
  } });
  const result = await runtime.handle(options.request('source-drift'));
  expect(result).toMatchObject({ reply: null, quarantineWorker: true, reason: 'quarantined' });
  expect(readFileSync(join(options.repoDir, file), 'utf8')).toBe('test(() => {})');
  expect(existsSync(join(result.artifactsDir!, 'reply.json'))).toBe(false);
  expect(await runtime.handle(options.request('later'))).toMatchObject({ reason: 'quarantined' });
});

test('the real checkout rejects a claimed cut that is not its HEAD before running a file', async () => {
  const options = root();
  const repoDir = options.repoDir;
  const head = options.request('source').cutSha;
  const lockHash = options.request('source').key.lockHash;
  expect(warmWorkerSourceMatches(repoDir, head, lockHash)).toBe(true);
  expect(warmWorkerSourceMatches(repoDir, 'a'.repeat(40), lockHash)).toBe(false);
  let calls = 0;
  const runtime = new WarmWorkerRuntime({ ...options, repoDir,
    runFile: async () => { calls++; return 0; } });
  const rejected = await runtime.handle({ ...options.request('wrong-cut'), cutSha: 'a'.repeat(40) });
  expect(rejected).toMatchObject({ reply: null, quarantineWorker: true, reason: 'quarantined' });
  expect(calls).toBe(0);
  expect(existsSync(options.artifactsRoot)).toBe(false);
});

test('deadline crossed at reply creation quarantines worker and leaves no reply', async () => {
  const options = root();
  let tick = 0;
  const runtime = new WarmWorkerRuntime({ ...options, now: () => ++tick,
    runFile: async request => { complete(request); return 0; } });
  const result = await runtime.handle({ ...options.request('deadline-at-reply'), deadlineAt: 6 });
  expect(result).toMatchObject({ reply: null, quarantineWorker: true, reason: 'execution-error' });
  expect(existsSync(join(result.artifactsDir!, 'reply.json'))).toBe(false);
  expect(await runtime.handle({ ...options.request('later'), deadlineAt: 100 })).toMatchObject({ reason: 'quarantined' });
});
