import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkEvidence, claudeBackend, codexBackend, runAgentMission, terminateMissionProcessTree, type AgentMissionDeps, type AgentMissionSpec } from './driver.js';
import { runClaudeHeadless } from './claude-headless.js';
import type { PtyHandle } from '../pty-shell/registry.js';

async function fixture(action: 'old' | 'write' | 'abort' | 'outside') {
  const root = mkdtempSync(join(tmpdir(), 'mission-workdir-'));
  const workdir = join(root, 'clips');
  mkdirSync(workdir);
  const oldFile = join(workdir, 'old.mp4');
  writeFileSync(oldFile, 'old');
  utimesSync(oldFile, new Date(2000, 0, 1), new Date(2000, 0, 1));
  const controller = new AbortController();
  const termSignals: Array<[number, string | number]> = [];
  const calls = { create: 0, commit: 0, provenance: 0, spawn: 0, killed: 0, headless: 0, decisions: [] as unknown[], cwd: '' };
  let status = action === 'outside' ? ' M preexisting.txt\n' : '';
  let releaseControl: (() => void) | undefined;
  const spec: AgentMissionSpec = {
    mission: 'make a clip', repo: root, workdir, signal: controller.signal, agent: codexBackend,
    evidence: { kind: 'doc', dirRel: '.', glob: /\.mp4$/ }, memory: false, screensDir: join(workdir, 'screens'),
  };
  const deps: AgentMissionDeps = {
    repoStatus: () => status,
    createWorktree: (() => { calls.create++; throw new Error('create worktree forbidden'); }) as never,
    recordWorktreeProvenance: (() => { calls.provenance++; }) as never,
    commitWorktree: (() => { calls.commit++; throw new Error('commit forbidden'); }) as never,
    emitDecision: ((decision: unknown) => { calls.decisions.push(decision); }) as never,
    resolvePtyWebAddress: () => ({ webUrl: null, webUrlSource: null, pwaUnavailableReason: 'test' }) as never,
    startPty: (opts) => {
      calls.spawn++;
      calls.cwd = opts.workdir!;
      return {
        id: opts.id, pid: 10, kind: 'codex', nickname: 'clip', accessMode: 'auto',
        isAlive: () => true, canWrite: () => true, drainDelta: () => '', renderScreen: async () => '',
        renderScreenPng: async () => null, write: () => {}, kill: () => { calls.killed++; releaseControl?.(); },
      } as unknown as PtyHandle;
    },
    terminateProcessTree: ((pid: number) => terminateMissionProcessTree(pid, {
      processTable: () => '10 1\n11 10\n12 11\n',
      signal: (id, sig) => { termSignals.push([id, sig]); if (sig === 0) throw new Error('gone'); },
      wait: async () => {},
    })) as typeof terminateMissionProcessTree,
    runControlLoop: async () => {
      if (action === 'write') writeFileSync(join(workdir, 'slot.mp4'), 'new');
      if (action === 'outside') status += '?? src/new.ts\n';
      if (action === 'abort') {
        controller.abort();
        await new Promise<void>((resolve) => { releaseControl = resolve; });
      }
      return { termination: { kind: 'success', reason: 'done' }, steps: 1 };
    },
    runClaudeHeadless: (() => { calls.headless++; throw new Error('headless forbidden'); }) as never,
  };
  try {
    const result = await runAgentMission(spec, deps);
    return { result, calls, termSignals, workdir };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('workdir skips git, runs PTY in the folder by default, and accepts a new mp4', async () => {
  const { result, calls, workdir } = await fixture('write');
  expect(calls).toMatchObject({ create: 0, commit: 0, provenance: 0, spawn: 1, headless: 0, cwd: workdir });
  expect(result).toMatchObject({ ok: true, worktree: workdir, branch: null, committed: false });
  expect(result.evidencePath).toBe(join(workdir, 'slot.mp4'));
});

test('a pre-existing matching document does not count as this mission evidence', async () => {
  const { result } = await fixture('old');
  expect(result).toMatchObject({ ok: false, evidencePath: null, committed: false });
});

test('without workdir the original worktree, provenance and commit path remains active', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mission-git-fixture-'));
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'docs', 'fresh.md'), 'new');
  let create = 0, provenance = 0, commit = 0;
  const spec: AgentMissionSpec = { mission: 'done', branch: 'git-fixture', repo: root, agent: codexBackend,
    evidence: { kind: 'doc', dirRel: 'docs', glob: /fresh\.md/ }, memory: false, screensDir: join(root, 'screens') };
  try {
    const result = await runAgentMission(spec, {
      createWorktree: (() => { create++; return { path: root, branch: 'git-fixture', base: 'HEAD' }; }) as never,
      recordWorktreeProvenance: (() => { provenance++; }) as never,
      commitWorktree: (() => { commit++; return { ok: true, out: '' }; }) as never,
      resolvePtyWebAddress: () => ({ webUrl: null, webUrlSource: null, pwaUnavailableReason: 'test' }) as never,
      startPty: (opts) => ({ id: opts.id, kind: 'codex', nickname: 'git-fixture', accessMode: 'auto',
        isAlive: () => true, canWrite: () => true, drainDelta: () => '', renderScreen: async () => '',
        renderScreenPng: async () => null, write: () => {}, kill: () => {} }) as unknown as PtyHandle,
      runControlLoop: async () => ({ termination: { kind: 'success', reason: 'done' }, steps: 1 }),
      checkEvidence: (wt, ev) => checkEvidence(wt, ev, { changedPaths: () => ['docs/fresh.md'] }),
    });
    expect([create, provenance, commit]).toEqual([1, 1, 1]);
    expect(result).toMatchObject({ ok: true, committed: true, branch: 'git-fixture' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Claude with explicit headless false uses PTY in workdir, never the headless runner', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mission-claude-pty-'));
  let pty = 0, headless = 0;
  try {
    const result = await runAgentMission({ mission: 'clip', repo: root, workdir: root, headless: false,
      agent: claudeBackend, evidence: { kind: 'doc', dirRel: '.', glob: /clip\.mp4/ },
      memory: false, screensDir: join(root, 'screens') }, {
      repoStatus: () => '',
      checkClaudeSubscription: (() => ({ ok: true })) as never,
      runClaudeHeadless: (() => { headless++; throw new Error('headless forbidden'); }) as never,
      resolvePtyWebAddress: () => ({ webUrl: null, webUrlSource: null, pwaUnavailableReason: 'test' }) as never,
      startPty: (opts) => { pty++; expect(opts.workdir).toBe(root);
        return { id: opts.id, kind: 'claude', nickname: 'clip', accessMode: 'auto',
          isAlive: () => true, canWrite: () => true, drainDelta: () => '', renderScreen: async () => '',
          renderScreenPng: async () => null, write: () => {}, kill: () => {} } as unknown as PtyHandle; },
      runControlLoop: async () => { writeFileSync(join(root, 'clip.mp4'), 'clip');
        return { termination: { kind: 'success', reason: 'done' }, steps: 1 }; },
    });
    expect([pty, headless, result.ok]).toEqual([1, 0, true]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('workdir with an explicit branch retains only the label, never creates a git branch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mission-branch-label-'));
  const controller = new AbortController();
  try {
    const result = await runAgentMission({ mission: 'done', repo: root, workdir: root, branch: 'slot-label',
      signal: controller.signal, evidence: { kind: 'doc', dirRel: '.', glob: /slot\.mp4/ },
      agent: codexBackend, memory: false, screensDir: join(root, 'screens') }, {
      repoStatus: () => '', createWorktree: (() => { throw new Error('git branch forbidden'); }) as never,
      resolvePtyWebAddress: () => ({ webUrl: null, webUrlSource: null, pwaUnavailableReason: 'test' }) as never,
      startPty: (opts) => ({ id: opts.id, kind: 'codex', nickname: 'slot-label', accessMode: 'auto',
        isAlive: () => true, canWrite: () => true, drainDelta: () => '', renderScreen: async () => '',
        renderScreenPng: async () => null, write: () => {}, kill: () => {} }) as unknown as PtyHandle,
      runControlLoop: async () => { writeFileSync(join(root, 'slot.mp4'), 'clip');
        return { termination: { kind: 'success', reason: 'done' }, steps: 1 }; },
    });
    expect(result).toMatchObject({ ok: true, branch: 'slot-label', committed: false });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('workdir rejects tsc evidence before spawning', async () => {
  const controller = new AbortController();
  await expect(runAgentMission({ mission: 'x', workdir: '/tmp', signal: controller.signal, evidence: { kind: 'tsc' }, agent: codexBackend })).rejects.toThrow('workdir 모드는 doc 증거만');
});

test('workdir rejects test evidence before spawning', async () => {
  await expect(runAgentMission({ mission: 'x', workdir: '/tmp', evidence: { kind: 'test', testPath: 'x.test.ts' }, agent: codexBackend }))
    .rejects.toThrow('workdir 모드는 doc 증거만');
});

test('already aborted signal does not spawn even a worktree', async () => {
  const controller = new AbortController(); controller.abort();
  let spawned = 0, statuses = 0;
  const result = await runAgentMission({ mission: 'x', workdir: '/tmp', signal: controller.signal, evidence: { kind: 'doc', dirRel: '.', glob: /x/ }, agent: codexBackend }, {
    repoStatus: () => { statuses++; return ''; }, startPty: (() => { spawned++; }) as never,
    createWorktree: (() => { spawned++; }) as never,
  });
  expect(result.reason).toBe('aborted');
  expect([spawned, statuses]).toEqual([0, 0]);
});

test('abort ends the PTY and includes grandchildren in tree termination', async () => {
  const { result, calls, termSignals } = await fixture('abort');
  expect(result).toMatchObject({ ok: false, reason: 'aborted', committed: false });
  expect(termSignals.filter(([, sig]) => sig === 'SIGTERM').map(([pid]) => pid)).toEqual([12, 11, 10]);
  expect(calls.killed).toBe(1);
});

test('explicit Claude headless abort kills the spawned process tree before returning', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mission-claude-abort-'));
  const controller = new AbortController();
  let kill = 0;
  let releaseHeadless: (() => void) | undefined;
  const terminated: number[] = [];
  try {
    const result = await runAgentMission({ mission: 'clip', repo: root, workdir: root, headless: true,
      signal: controller.signal, agent: claudeBackend, memory: false,
      evidence: { kind: 'doc', dirRel: '.', glob: /clip\.mp4$/ }, screensDir: join(root, 'screens') }, {
      repoStatus: () => '', checkClaudeSubscription: (() => ({ ok: true })) as never,
      runClaudeHeadless: (async ({ onSpawn }) => {
        onSpawn?.(10, () => { kill++; releaseHeadless?.(); });
        controller.abort();
        await new Promise<void>((resolve) => { releaseHeadless = resolve; });
        throw new Error('headless terminated');
      }) as AgentMissionDeps['runClaudeHeadless'],
      terminateProcessTree: (async (pid: number) => {
        terminated.push(pid, 11, 12);
        return [12, 11, pid];
      }) as typeof terminateMissionProcessTree,
    });
    expect(result.reason).toBe('aborted');
    expect(terminated).toEqual([10, 11, 12]);
    expect(kill).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('real Claude headless runner publishes its child pid for cancellation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mission-headless-child-'));
  const controller = new AbortController();
  let pid = 0;
  let descendants: number[] = [];
  try {
    const result = await runAgentMission({ mission: 'clip', repo: root, workdir: root, headless: true,
      signal: controller.signal, agent: claudeBackend, memory: false,
      evidence: { kind: 'doc', dirRel: '.', glob: /clip\.mp4$/ }, screensDir: join(root, 'screens') }, {
      repoStatus: () => '', checkClaudeSubscription: (() => ({ ok: true })) as never,
      runClaudeHeadless: ((opts) => runClaudeHeadless({ ...opts, spawn: ((_cmd, _args, options) =>
        spawn('/bin/sh', ['-c', 'sleep 311 & sleep 311 & wait'], options) as never),
        onSpawn: async (childPid, kill) => {
          pid = childPid;
          opts.onSpawn?.(childPid, kill);
          for (let i = 0; i < 50; i++) {
            descendants = execFileSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8' }).split('\n')
              .map((line) => line.trim().split(/\s+/).map(Number))
              .filter(([, parent]) => parent === childPid).map(([id]) => id!);
            if (descendants.length === 2) break;
            await Bun.sleep(20);
          }
          controller.abort();
        },
      })) as AgentMissionDeps['runClaudeHeadless'],
    });
    expect(result.reason).toBe('aborted');
    expect(descendants).toHaveLength(2);
    await Bun.sleep(100);
    let states = '';
    try { states = execFileSync('ps', ['-o', 'stat=', '-p', [pid, ...descendants].join(',')], { encoding: 'utf8' }); }
    catch { /* no matching processes */ }
    expect(states.split('\n').filter((state) => state.trim() && !state.trim().startsWith('Z'))).toEqual([]);
  } finally {
    for (const id of [pid, ...descendants]) if (id) try { process.kill(id, 'SIGKILL'); } catch { /* exited */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test('real shell tree with two sleep 311 children has no running descendants after termination', async () => {
  const child = spawn('/bin/sh', ['-c', 'sleep 311 & sleep 311 & wait'], { stdio: 'ignore' });
  const pid = child.pid!;
  const descendants = (): number[] => {
    const lines = execFileSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8' }).split('\n');
    return lines.map((line) => line.trim().split(/\s+/).map(Number))
      .filter(([, parent]) => parent === pid).map(([id]) => id!);
  };
  let pids: number[] = [];
  try {
    for (let i = 0; i < 50; i++) {
      pids = descendants();
      if (pids.length === 2) break;
      await Bun.sleep(20);
    }
    expect(pids).toHaveLength(2);
    await terminateMissionProcessTree(pid);
    await Bun.sleep(1000);
    let states = '';
    try { states = execFileSync('ps', ['-o', 'stat=', '-p', [pid, ...pids].join(',')], { encoding: 'utf8' }); }
    catch { /* ps exits 1 when no matching processes remain. */ }
    expect(states.split('\n').filter((state) => state.trim() && !state.trim().startsWith('Z'))).toEqual([]);
  } finally {
    for (const id of [pid, ...pids]) try { process.kill(id, 'SIGKILL'); } catch { /* exited */ }
  }
}, 10000);

test('real git status includes an in-repo workdir clip without treating it as an outside write', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mission-real-git-'));
  const workdir = join(root, 'clips');
  mkdirSync(workdir);
  execFileSync('git', ['init', '-q', root]);
  try {
    const decisions: unknown[] = [];
    const result = await runAgentMission({ mission: 'clip', repo: root, workdir, agent: codexBackend,
      evidence: { kind: 'doc', dirRel: '.', glob: /\.mp4$/ }, memory: false, screensDir: join(workdir, 'screens') }, {
      emitDecision: ((decision: unknown) => { decisions.push(decision); }) as never,
      resolvePtyWebAddress: () => ({ webUrl: null, webUrlSource: null, pwaUnavailableReason: 'test' }) as never,
      startPty: (opts) => ({ id: opts.id, kind: 'codex', nickname: 'clip', accessMode: 'auto',
        isAlive: () => true, canWrite: () => true, drainDelta: () => '', renderScreen: async () => '',
        renderScreenPng: async () => null, write: () => {}, kill: () => {} }) as unknown as PtyHandle,
      runControlLoop: async () => { writeFileSync(join(workdir, 'slot.mp4'), 'clip');
        return { termination: { kind: 'success', reason: 'done' }, steps: 1 }; },
    });
    expect(result).toMatchObject({ ok: true, worktree: workdir, committed: false });
    expect(decisions).toEqual([]);
    expect(execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8' })).toContain('clips/slot.mp4');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('writes to already modified tracked and untracked files outside workdir escalate', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mission-existing-git-'));
  const workdir = join(root, 'clips');
  mkdirSync(workdir);
  execFileSync('git', ['init', '-q', root]);
  writeFileSync(join(root, 'tracked.txt'), 'committed');
  execFileSync('git', ['add', 'tracked.txt'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'initial'], { cwd: root });
  writeFileSync(join(root, 'tracked.txt'), 'dirty before');
  writeFileSync(join(root, 'untracked.txt'), 'untracked before');
  try {
    const decisions: unknown[] = [];
    const result = await runAgentMission({ mission: 'clip', repo: root, workdir, agent: codexBackend,
      evidence: { kind: 'doc', dirRel: '.', glob: /\.mp4$/ }, memory: false, screensDir: join(workdir, 'screens') }, {
      emitDecision: ((decision: unknown) => { decisions.push(decision); }) as never,
      resolvePtyWebAddress: () => ({ webUrl: null, webUrlSource: null, pwaUnavailableReason: 'test' }) as never,
      startPty: (opts) => ({ id: opts.id, kind: 'codex', nickname: 'clip', accessMode: 'auto',
        isAlive: () => true, canWrite: () => true, drainDelta: () => '', renderScreen: async () => '',
        renderScreenPng: async () => null, write: () => {}, kill: () => {} }) as unknown as PtyHandle,
      runControlLoop: async () => {
        writeFileSync(join(workdir, 'slot.mp4'), 'clip');
        writeFileSync(join(root, 'tracked.txt'), 'dirty after');
        writeFileSync(join(root, 'untracked.txt'), 'untracked after');
        return { termination: { kind: 'success', reason: 'done' }, steps: 1 };
      },
    });
    expect(result).toMatchObject({ ok: false, reason: 'outside-write', paths: ['tracked.txt', 'untracked.txt'] });
    expect(decisions).toHaveLength(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('NUL porcelain keeps a literal arrow in an outside filename', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mission-arrow-'));
  const workdir = join(root, 'clips');
  mkdirSync(workdir);
  execFileSync('git', ['init', '-q', root]);
  const filename = 'from -> target.txt';
  try {
    const result = await runAgentMission({ mission: 'clip', repo: root, workdir, agent: codexBackend,
      evidence: { kind: 'doc', dirRel: '.', glob: /\.mp4$/ }, memory: false, screensDir: join(workdir, 'screens') }, {
      resolvePtyWebAddress: () => ({ webUrl: null, webUrlSource: null, pwaUnavailableReason: 'test' }) as never,
      startPty: (opts) => ({ id: opts.id, kind: 'codex', nickname: 'clip', accessMode: 'auto',
        isAlive: () => true, canWrite: () => true, drainDelta: () => '', renderScreen: async () => '',
        renderScreenPng: async () => null, write: () => {}, kill: () => {} }) as unknown as PtyHandle,
      emitDecision: (() => {}) as never,
      runControlLoop: async () => { writeFileSync(join(workdir, 'slot.mp4'), 'clip');
        writeFileSync(join(root, filename), 'new');
        return { termination: { kind: 'success', reason: 'done' }, steps: 1 }; },
    });
    expect(result).toMatchObject({ ok: false, reason: 'outside-write', paths: [filename] });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('ignored files outside workdir are detected when created or modified', async () => {
  for (const existed of [false, true]) {
    const root = mkdtempSync(join(tmpdir(), 'mission-ignored-'));
    const workdir = join(root, 'clips');
    mkdirSync(workdir);
    execFileSync('git', ['init', '-q', root]);
    writeFileSync(join(root, '.gitignore'), 'ignored.txt\n');
    if (existed) writeFileSync(join(root, 'ignored.txt'), 'before');
    try {
      const decisions: unknown[] = [];
      const result = await runAgentMission({ mission: 'clip', repo: root, workdir, agent: codexBackend,
        evidence: { kind: 'doc', dirRel: '.', glob: /\.mp4$/ }, memory: false, screensDir: join(workdir, 'screens') }, {
        emitDecision: ((decision: unknown) => { decisions.push(decision); }) as never,
        resolvePtyWebAddress: () => ({ webUrl: null, webUrlSource: null, pwaUnavailableReason: 'test' }) as never,
        startPty: (opts) => ({ id: opts.id, kind: 'codex', nickname: 'clip', accessMode: 'auto',
          isAlive: () => true, canWrite: () => true, drainDelta: () => '', renderScreen: async () => '',
          renderScreenPng: async () => null, write: () => {}, kill: () => {} }) as unknown as PtyHandle,
        runControlLoop: async () => { writeFileSync(join(workdir, 'slot.mp4'), 'clip');
          writeFileSync(join(root, 'ignored.txt'), 'after');
          return { termination: { kind: 'success', reason: 'done' }, steps: 1 }; },
      });
      expect(result).toMatchObject({ ok: false, reason: 'outside-write', paths: ['ignored.txt'] });
      expect(decisions).toHaveLength(1);
      expect(execFileSync('git', ['status', '--porcelain', '--ignored', '--', 'ignored.txt'], { cwd: root, encoding: 'utf8' })).toContain('!! ignored.txt');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('abort after a fallback terminates the replacement PTY tree', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mission-fallback-abort-'));
  const workdir = join(root, 'clips');
  mkdirSync(workdir);
  const controller = new AbortController();
  const spawned: number[] = [], terminated: number[] = [];
  let releaseControl: (() => void) | undefined;
  try {
    const result = await runAgentMission({ mission: 'clip', repo: root, workdir, signal: controller.signal,
      evidence: { kind: 'doc', dirRel: '.', glob: /\.mp4$/ }, memory: false, screensDir: join(workdir, 'screens') }, {
      repoStatus: () => '',
      resolveRunFallback: () => ({ action: 'switch-backend', backend: 'grok' }),
      resolvePtyWebAddress: () => ({ webUrl: null, webUrlSource: null, pwaUnavailableReason: 'test' }) as never,
      terminateProcessTree: ((pid: number) => terminateMissionProcessTree(pid, {
        processTable: () => '10 1\n11 10\n20 1\n21 20\n',
        signal: (id, sig) => { if (sig === 'SIGTERM') terminated.push(id); if (sig === 0) throw new Error('gone'); },
        wait: async () => {},
      })) as typeof terminateMissionProcessTree,
      startPty: (opts) => { const pid = spawned.length ? 20 : 10; spawned.push(pid);
        return { id: opts.id, pid, kind: opts.kind, nickname: 'clip', accessMode: 'auto',
          isAlive: () => true, canWrite: () => true, drainDelta: () => '', renderScreen: async () => '',
          renderScreenPng: async () => null, write: () => {}, kill: () => { releaseControl?.(); } } as unknown as PtyHandle; },
      runControlLoop: async () => {
        if (spawned.length === 1) return { termination: { kind: 'error', message: '429 rate limit' }, steps: 1 };
        controller.abort();
        await new Promise<void>((resolve) => { releaseControl = resolve; });
        return { termination: { kind: 'success', reason: 'stopped' }, steps: 1 };
      },
    });
    expect(spawned).toEqual([10, 20]);
    expect(terminated).toEqual([11, 10, 21, 20]);
    expect(result).toMatchObject({ ok: false, reason: 'aborted' });
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 10000);

test('a matching file with future mtime before mission is not evidence until its contents change', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mission-future-'));
  const clip = join(root, 'future.mp4');
  writeFileSync(clip, 'existing');
  utimesSync(clip, new Date('2099-01-01'), new Date('2099-01-01'));
  try {
    for (const rewrite of [false, true]) {
      const result = await runAgentMission({ mission: 'clip', repo: root, workdir: root, agent: codexBackend,
        evidence: { kind: 'doc', dirRel: '.', glob: /future\.mp4$/ }, memory: false, screensDir: join(root, 'screens') }, {
        repoStatus: () => '',
        resolvePtyWebAddress: () => ({ webUrl: null, webUrlSource: null, pwaUnavailableReason: 'test' }) as never,
        startPty: (opts) => ({ id: opts.id, kind: 'codex', accessMode: 'auto', isAlive: () => true,
          canWrite: () => true, drainDelta: () => '', renderScreen: async () => '', renderScreenPng: async () => null,
          write: () => {}, kill: () => {} }) as unknown as PtyHandle,
        runControlLoop: async () => { if (rewrite) writeFileSync(clip, 'rewritten');
          return { termination: { kind: 'success', reason: 'done' }, steps: 1 }; },
      });
      expect(result.ok).toBe(rewrite);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('writing through an external symlink escalates the link path', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mission-link-'));
  const outside = mkdtempSync(join(tmpdir(), 'mission-link-target-'));
  const workdir = join(root, 'clips');
  mkdirSync(workdir);
  writeFileSync(join(outside, 'target.txt'), 'before');
  symlinkSync(join(outside, 'target.txt'), join(workdir, 'link.txt'));
  try {
    const decisions: unknown[] = [];
    const result = await runAgentMission({ mission: 'clip', repo: root, workdir, agent: codexBackend,
      evidence: { kind: 'doc', dirRel: '.', glob: /slot\.mp4$/ }, memory: false, screensDir: join(workdir, 'screens') }, {
      repoStatus: () => '', emitDecision: ((decision: unknown) => { decisions.push(decision); }) as never,
      resolvePtyWebAddress: () => ({ webUrl: null, webUrlSource: null, pwaUnavailableReason: 'test' }) as never,
      startPty: (opts) => ({ id: opts.id, kind: 'codex', accessMode: 'auto', isAlive: () => true,
        canWrite: () => true, drainDelta: () => '', renderScreen: async () => '', renderScreenPng: async () => null,
        write: () => {}, kill: () => {} }) as unknown as PtyHandle,
      runControlLoop: async () => { writeFileSync(join(workdir, 'slot.mp4'), 'new');
        writeFileSync(join(workdir, 'link.txt'), 'after');
        return { termination: { kind: 'success', reason: 'done' }, steps: 1 }; },
    });
    expect(result).toMatchObject({ ok: false, reason: 'outside-write', paths: [join(workdir, 'link.txt')] });
    expect(decisions).toHaveLength(1);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test('abort waits for control-loop shutdown before the final repository inspection', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mission-late-'));
  const workdir = join(root, 'clips');
  mkdirSync(workdir);
  const controller = new AbortController();
  let inspected = 0;
  try {
    const result = await runAgentMission({ mission: 'clip', repo: root, workdir, signal: controller.signal,
      agent: codexBackend, evidence: { kind: 'doc', dirRel: '.', glob: /slot\.mp4$/ },
      memory: false, screensDir: join(workdir, 'screens') }, {
      repoStatus: () => { inspected++; return ''; },
      resolvePtyWebAddress: () => ({ webUrl: null, webUrlSource: null, pwaUnavailableReason: 'test' }) as never,
      terminateProcessTree: (async (pid: number) => [pid]) as typeof terminateMissionProcessTree,
      startPty: (opts) => ({ id: opts.id, pid: 10, kind: 'codex', accessMode: 'auto', isAlive: () => true,
        canWrite: () => true, drainDelta: () => '', renderScreen: async () => '', renderScreenPng: async () => null,
        write: () => {}, kill: () => {} }) as unknown as PtyHandle,
      runControlLoop: async () => { controller.abort(); await Bun.sleep(50);
        writeFileSync(join(root, 'late.txt'), 'after abort');
        return { termination: { kind: 'success', reason: 'done' }, steps: 1 }; },
    });
    await Bun.sleep(75);
    expect(result).toMatchObject({ ok: false, reason: 'outside-write', paths: ['late.txt'] });
    expect(inspected).toBe(2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a new repository status entry escalates and overrides evidence success', async () => {
  const { result, calls } = await fixture('outside');
  expect(result).toMatchObject({ ok: false, reason: 'outside-write', paths: ['src/new.ts'] });
  expect(calls.decisions).toEqual([{ kind: 'ESCALATE', what: '작업 폴더 밖 쓰기', reason: 'src/new.ts', purpose: '사람이 확인한다', target: 'human' }]);
  expect(calls.commit).toBe(0);
});

const quietPty: NonNullable<AgentMissionDeps["startPty"]> = (opts) => ({ id: opts.id, pid: 10, kind: 'codex', accessMode: 'auto', isAlive: () => true,
  canWrite: () => true, drainDelta: () => '', renderScreen: async () => '', renderScreenPng: async () => null,
  write: () => {}, kill: () => {} }) as unknown as PtyHandle;
const noWeb = () => ({ webUrl: null, webUrlSource: null, pwaUnavailableReason: 'test' }) as never;

test('a git config change outside the workdir escalates even though git status cannot see it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mission-gitconfig-'));
  const workdir = join(root, 'clips');
  mkdirSync(workdir);
  execFileSync('git', ['init', '-q', root]);
  try {
    const result = await runAgentMission({ mission: 'clip', repo: root, workdir, agent: codexBackend,
      evidence: { kind: 'doc', dirRel: '.', glob: /slot\.mp4$/ }, memory: false, screensDir: join(workdir, 'screens') }, {
      emitDecision: (() => {}) as never, resolvePtyWebAddress: noWeb, startPty: quietPty,
      runControlLoop: async () => {
        writeFileSync(join(workdir, 'slot.mp4'), 'clip');
        execFileSync('git', ['config', 'core.hooksPath', '/tmp/evil-hooks'], { cwd: root });
        return { termination: { kind: 'success', reason: 'done' }, steps: 1 };
      },
    });
    expect(result).toMatchObject({ ok: false, reason: 'outside-write', paths: ['.git/config'] });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('writing through a nested link inside an external linked directory escalates', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mission-nested-link-'));
  const outside = mkdtempSync(join(tmpdir(), 'mission-nested-a-'));
  const further = mkdtempSync(join(tmpdir(), 'mission-nested-b-'));
  const workdir = join(root, 'clips');
  mkdirSync(workdir);
  writeFileSync(join(further, 'target.txt'), 'before');
  symlinkSync(join(further, 'target.txt'), join(outside, 'nested'));
  symlinkSync(outside, join(workdir, 'link'));
  try {
    const result = await runAgentMission({ mission: 'clip', repo: root, workdir, agent: codexBackend,
      evidence: { kind: 'doc', dirRel: '.', glob: /slot\.mp4$/ }, memory: false, screensDir: join(workdir, 'screens') }, {
      repoStatus: () => '', emitDecision: (() => {}) as never, resolvePtyWebAddress: noWeb, startPty: quietPty,
      runControlLoop: async () => {
        writeFileSync(join(workdir, 'slot.mp4'), 'clip');
        writeFileSync(join(workdir, 'link', 'nested'), 'after');
        return { termination: { kind: 'success', reason: 'done' }, steps: 1 };
      },
    });
    expect(result).toMatchObject({ ok: false, reason: 'outside-write', paths: [join(workdir, 'link')] });
  } finally { for (const dir of [root, outside, further]) rmSync(dir, { recursive: true, force: true }); }
});

test('cancel returns within the drain bound when a control stage ignores cancellation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mission-drain-'));
  const workdir = join(root, 'clips');
  mkdirSync(workdir);
  const controller = new AbortController();
  try {
    const started = Date.now();
    const result = await runAgentMission({ mission: 'clip', repo: root, workdir, signal: controller.signal, agent: codexBackend,
      evidence: { kind: 'doc', dirRel: '.', glob: /slot\.mp4$/ }, memory: false, screensDir: join(workdir, 'screens') }, {
      repoStatus: () => '', cancelDrainMs: 50, resolvePtyWebAddress: noWeb, startPty: quietPty,
      terminateProcessTree: (async (pid: number) => [pid]) as typeof terminateMissionProcessTree,
      runControlLoop: () => { controller.abort(); return new Promise(() => {}); },
    });
    expect(result).toMatchObject({ ok: false, reason: 'aborted' });
    expect(Date.now() - started).toBeLessThan(5_000);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a cancel that arrives during the final inspection is reported as aborted, not success', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mission-final-cancel-'));
  const workdir = join(root, 'clips');
  mkdirSync(workdir);
  const controller = new AbortController();
  let inspected = 0;
  try {
    const result = await runAgentMission({ mission: 'clip', repo: root, workdir, signal: controller.signal, agent: codexBackend,
      evidence: { kind: 'doc', dirRel: '.', glob: /slot\.mp4$/ }, memory: false, screensDir: join(workdir, 'screens') }, {
      repoStatus: () => { inspected++; if (inspected === 2) controller.abort(); return ''; },
      resolvePtyWebAddress: noWeb, startPty: quietPty,
      runControlLoop: async () => { writeFileSync(join(workdir, 'slot.mp4'), 'clip');
        return { termination: { kind: 'success', reason: 'done' }, steps: 1 }; },
    });
    expect(inspected).toBeGreaterThanOrEqual(2);
    expect(result).toMatchObject({ ok: false, reason: 'aborted' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const clipPty: NonNullable<AgentMissionDeps['startPty']> = (opts) => ({ id: opts.id, pid: 10, kind: 'codex', accessMode: 'auto',
  isAlive: () => true, canWrite: () => true, drainDelta: () => '', renderScreen: async () => '', renderScreenPng: async () => null,
  write: () => {}, kill: () => {} }) as unknown as PtyHandle;
const clipWeb = () => ({ webUrl: null, webUrlSource: null, pwaUnavailableReason: 'test' }) as never;

test('a workdir outside any repository is not failed by writes in the launcher tree', async () => {
  const launcher = mkdtempSync(join(tmpdir(), 'mission-launcher-'));
  const workdir = mkdtempSync(join(tmpdir(), 'mission-media-'));
  execFileSync('git', ['init', '-q', launcher]);
  const cwd = process.cwd();
  process.chdir(launcher);
  try {
    const result = await runAgentMission({ mission: 'clip', workdir, agent: codexBackend,
      evidence: { kind: 'doc', dirRel: '.', glob: /slot\.mp4$/ }, memory: false, screensDir: join(workdir, 'screens') }, {
      emitDecision: (() => {}) as never, resolvePtyWebAddress: clipWeb, startPty: clipPty,
      runControlLoop: async () => {
        writeFileSync(join(workdir, 'slot.mp4'), 'clip');
        writeFileSync(join(launcher, 'launcher-log.txt'), 'the launcher kept logging');
        return { termination: { kind: 'success', reason: 'done' }, steps: 1 };
      },
    });
    expect(result).toMatchObject({ ok: true });
  } finally {
    process.chdir(cwd);
    rmSync(launcher, { recursive: true, force: true }); rmSync(workdir, { recursive: true, force: true });
  }
});

test('a workdir inside another repository inspects that repository, not the launcher tree', async () => {
  const launcher = mkdtempSync(join(tmpdir(), 'mission-launcher-'));
  const root = mkdtempSync(join(tmpdir(), 'mission-owner-'));
  const workdir = join(root, 'clips');
  mkdirSync(workdir);
  execFileSync('git', ['init', '-q', launcher]);
  execFileSync('git', ['init', '-q', root]);
  const cwd = process.cwd();
  process.chdir(launcher);
  try {
    const result = await runAgentMission({ mission: 'clip', workdir, agent: codexBackend,
      evidence: { kind: 'doc', dirRel: '.', glob: /slot\.mp4$/ }, memory: false, screensDir: join(workdir, 'screens') }, {
      emitDecision: (() => {}) as never, resolvePtyWebAddress: clipWeb, startPty: clipPty,
      runControlLoop: async () => {
        writeFileSync(join(workdir, 'slot.mp4'), 'clip');
        writeFileSync(join(root, 'owner-file.txt'), 'outside the workdir');
        return { termination: { kind: 'success', reason: 'done' }, steps: 1 };
      },
    });
    expect(result).toMatchObject({ ok: false, reason: 'outside-write', paths: ['owner-file.txt'] });
  } finally {
    process.chdir(cwd);
    rmSync(launcher, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true });
  }
});
