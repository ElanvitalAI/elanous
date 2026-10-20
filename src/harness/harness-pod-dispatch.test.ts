import { describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { debug } from '../debug/log.js';
import { dispatchHarnessOnPod, podOrchestrateArgs, resolveHarnessPodPool } from './harness-pod-dispatch.js';
import { podMemoryLimitFor } from '../task-orchestrator/surfaces/self-implement-pod.js';
import { parsePodPool } from '../task-orchestrator/surfaces/pod-pool.js';
import { podSourceScript } from '../task-orchestrator/surfaces/pod-source-receive.js';
import { HARNESS_RUN_ID_ENV } from './harness-space.js';
import type { RunLedgerEntry } from '../self-implement/run-ledger.js';

function matchDefaultPodSource(root: string): string {
  const origin = mkdtempSync(join(tmpdir(), 'pod-default-origin-'));
  execFileSync('git', ['init', '--bare', '-q', origin]);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Pod preflight test']);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'pod-preflight@example.invalid']);
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, 'commit', '-qm', 'fixture']);
  execFileSync('git', ['-C', root, 'remote', 'add', 'origin', origin]);
  execFileSync('git', ['-C', root, 'push', '-q', '-u', 'origin', 'HEAD:main']);
  execFileSync('git', ['-C', origin, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  return origin;
}

describe('harness say/ask --substrate pod', () => {
  test('TA source request and GOAL must carry three completion lines before Pod child spawn', () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-ta-boundary-'));
    const goal = join(root, 'GOAL-ta-boundary.md');
    const complete = '- 완료 경계 코드: 수정 코드가 있다\n- 완료 경계 실물: CLI 경로에서 확인한다\n- 완료 경계 증거 명령: bun test src/example.test.ts';
    writeFileSync(goal, `# Goal\n\n## ACCEPTANCE CRITERIA\n\n- 기존 조건\n`);
    const previous = process.env.ELANOUS_TASK_CARD_ID;
    process.env.ELANOUS_TASK_CARD_ID = 'ta-pod-boundary';
    const events: Array<{ event: string; data: unknown }> = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category, event, data) => { events.push({ event, data }); }) as typeof debug.log);
    let launches = 0;
    const run = () => { launches++; return 0; };
    try {
      expect(dispatchHarnessOnPod({ entrance: 'cli-harness-say', input: '수정해라', authorOnPod: true }, { run })).toBe(2);
      expect(dispatchHarnessOnPod({ entrance: 'cli-harness-ask', input: goal }, { run })).toBe(2);
      expect(launches).toBe(0);
      expect(events.filter((row) => row.event === 'goal-done-boundary-rejected')).toEqual([
        expect.objectContaining({ data: expect.objectContaining({ source: 'request', taskCardId: 'ta-pod-boundary' }) }),
        expect.objectContaining({ data: expect.objectContaining({ source: 'goal', taskCardId: 'ta-pod-boundary' }) }),
      ]);
      const wrapped = '- 완료 경계 코드: **[TBD]**\n- 완료 경계 실물: ~~(추후 결정)~~\n- 완료 경계 증거 명령: bun test src/example.test.ts';
      expect(dispatchHarnessOnPod({ entrance: 'cli-harness-say', input: wrapped, authorOnPod: true }, { run })).toBe(2);
      writeFileSync(goal, `# Goal\n\n## ACCEPTANCE CRITERIA\n\n${wrapped}\n`);
      expect(dispatchHarnessOnPod({ entrance: 'cli-harness-ask', input: goal }, { run })).toBe(2);
      expect(launches).toBe(0);
      expect(events.filter((row) => row.event === 'goal-done-boundary-rejected')).toHaveLength(4);
      expect(dispatchHarnessOnPod({ entrance: 'cli-harness-say', input: complete, authorOnPod: true }, { run })).toBe(0);
      writeFileSync(goal, `# Goal\n\n## ACCEPTANCE CRITERIA\n\n${complete}\n`);
      expect(dispatchHarnessOnPod({ entrance: 'cli-harness-ask', input: goal }, { run })).toBe(0);
      expect(launches).toBe(2);
    } finally {
      log.mockRestore();
      if (previous === undefined) delete process.env.ELANOUS_TASK_CARD_ID;
      else process.env.ELANOUS_TASK_CARD_ID = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('human say without completion lines warns and still dispatches the Pod child', () => {
    const previous = process.env.ELANOUS_TASK_CARD_ID;
    delete process.env.ELANOUS_TASK_CARD_ID;
    let launches = 0;
    const events: string[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category, event) => { events.push(event); }) as typeof debug.log);
    const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(dispatchHarnessOnPod({ entrance: 'cli-harness-say', input: '수정해라', authorOnPod: true }, {
        nowMs: Date.parse('2026-10-16T12:00:00+09:00'), run: () => { launches++; return 0; },
      })).toBe(0);
      expect(launches).toBe(1);
      expect(events).toContain('goal-done-boundary-warned');
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('사람 요청 관측 기간에는 발사를 계속합니다'));
    } finally {
      stderr.mockRestore();
      log.mockRestore();
      if (previous === undefined) delete process.env.ELANOUS_TASK_CARD_ID;
      else process.env.ELANOUS_TASK_CARD_ID = previous;
    }
  });

  test('unspecified document selects lite; implement retains standard and explicit tier wins', () => {
    const previous = process.env.ELANOUS_POD_MEMORY_TIER;
    const previousReason = process.env.ELANOUS_POD_MEMORY_REASON;
    delete process.env.ELANOUS_POD_MEMORY_TIER;
    delete process.env.ELANOUS_POD_MEMORY_REASON;
    const events: unknown[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data: unknown) => {
      if (category === 'harness.substrate' && event === 'memory-selected') events.push(data);
    }) as typeof debug.log);
    const seen: Array<{ tier: string | undefined; reason: string | undefined; limit: string }> = [];
    const run = (_cmd: string, _args: readonly string[], env: NodeJS.ProcessEnv) => {
      const memory = podMemoryLimitFor('Write the guide', env);
      seen.push({ tier: env.ELANOUS_POD_MEMORY_TIER, reason: env.ELANOUS_POD_MEMORY_REASON,
        limit: memory.limit });
      return 0;
    };
    try {
      dispatchHarnessOnPod({ entrance: 'cli-harness-say', input: 'Write the guide', goalType: 'document' }, { run });
      dispatchHarnessOnPod({ entrance: 'cli-harness-say', input: 'Implement the widget', goalType: 'implement' }, { run });
      dispatchHarnessOnPod({ entrance: 'cli-harness-say', input: 'Write the guide', goalType: 'document', podMemory: 'high' }, { run });
      dispatchHarnessOnPod({ entrance: 'cli-harness-say', input: '대상 경로: apps/pwa/page.tsx', goalType: 'implement' }, { run });
      dispatchHarnessOnPod({ entrance: 'cli-harness-say', input: 'Pod 메모리: standard\nWrite the guide', goalType: 'document' }, { run });
      dispatchHarnessOnPod({ entrance: 'cli-harness-say', input: 'Write the guide\n- GoalType: document' }, { run });
      process.env.ELANOUS_POD_MEMORY_TIER = 'high';
      dispatchHarnessOnPod({ entrance: 'cli-harness-say', input: 'Write the guide', goalType: 'document' }, { run });
      expect(seen).toEqual([
        { tier: 'lite', reason: 'goal-type-default', limit: '2Gi' },
        { tier: 'standard', reason: 'existing-tier', limit: '16Gi' },
        { tier: 'high', reason: 'explicit-option', limit: '32Gi' },
        { tier: 'high', reason: 'existing-tier', limit: '32Gi' },
        { tier: 'standard', reason: 'existing-tier', limit: '16Gi' },
        { tier: 'lite', reason: 'goal-type-default', limit: '2Gi' },
        { tier: 'high', reason: 'existing-tier', limit: '32Gi' },
      ]);
      expect(events).toEqual([
        expect.objectContaining({ goalType: 'document', tier: 'lite', reason: 'goal-type-default', memoryLimit: '2Gi' }),
        expect.objectContaining({ goalType: 'implement', tier: 'standard', reason: 'existing-tier', memoryLimit: '16Gi' }),
        expect.objectContaining({ goalType: 'document', tier: 'high', reason: 'explicit-option', memoryLimit: '32Gi' }),
        expect.objectContaining({ goalType: 'implement', tier: 'high', reason: 'existing-tier', memoryLimit: '32Gi' }),
        expect.objectContaining({ goalType: 'document', tier: 'standard', reason: 'existing-tier', memoryLimit: '16Gi' }),
        expect.objectContaining({ goalType: 'document', tier: 'lite', reason: 'goal-type-default', memoryLimit: '2Gi' }),
        expect.objectContaining({ goalType: 'document', tier: 'high', reason: 'existing-tier', memoryLimit: '32Gi' }),
      ]);
    } finally {
      log.mockRestore();
      if (previous === undefined) delete process.env.ELANOUS_POD_MEMORY_TIER;
      else process.env.ELANOUS_POD_MEMORY_TIER = previous;
      if (previousReason === undefined) delete process.env.ELANOUS_POD_MEMORY_REASON;
      else process.env.ELANOUS_POD_MEMORY_REASON = previousReason;
    }
  });

  test('a declared document ask without --pod-memory reaches the orchestrator with the lite tier', () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-document-ask-'));
    const goal = join(root, 'goal.md');
    writeFileSync(goal, 'Write a guide\n- GoalType: document\n');
    try {
      let selected: string | undefined;
      expect(dispatchHarnessOnPod({ entrance: 'cli-harness-ask', input: goal }, {
        run: (_command, args, env) => {
          expect(args[args.indexOf('--goal-file') + 1]).toBe(goal);
          selected = env.ELANOUS_POD_MEMORY_TIER;
          expect(env.ELANOUS_POD_MEMORY_REASON).toBe('goal-type-default');
          return 0;
        },
      })).toBe(0);
      expect(selected).toBe('lite');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('the explicit seat is present in the spawned orchestrator environment', () => {
    let stamped: string | undefined;
    dispatchHarnessOnPod({ entrance: 'cli-harness-say', input: 'goal', seat: 'TC' }, {
      run: (_command, _args, env) => { stamped = env.ELANOUS_HARNESS_SEAT; return 0; },
    });
    expect(stamped).toBe('TC');
  });

  test('harness say forwards HQ Codex owner markers into its self-orchestrate Pod child', () => {
    const keys = ['ELANOUS_REMOTE_CODEX_ACCOUNT', 'ELANOUS_REMOTE_CODEX_USED_PERCENT', 'ELANOUS_REMOTE_CODEX_THRESHOLD_PERCENT'] as const;
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    let seen: { args: string[]; env: NodeJS.ProcessEnv } | undefined;
    try {
      process.env.ELANOUS_REMOTE_CODEX_ACCOUNT = 'owner-team';
      process.env.ELANOUS_REMOTE_CODEX_USED_PERCENT = '42';
      process.env.ELANOUS_REMOTE_CODEX_THRESHOLD_PERCENT = '60';
      expect(dispatchHarnessOnPod({ entrance: 'cli-harness-say', input: 'goal' }, {
        run: (_command, args, env) => { seen = { args: [...args], env: { ...env } }; return 0; },
      })).toBe(0);
      expect(seen?.args.slice(1, 3)).toEqual(['self', 'orchestrate']);
      expect(seen?.args).toContain('--substrate');
      expect(seen?.args[seen!.args.indexOf('--substrate') + 1]).toBe('pod');
      expect(seen?.env).toMatchObject({
        ELANOUS_REMOTE_CODEX_ACCOUNT: 'owner-team',
        ELANOUS_REMOTE_CODEX_USED_PERCENT: '42',
        ELANOUS_REMOTE_CODEX_THRESHOLD_PERCENT: '60',
      });
    } finally {
      for (const key of keys) {
        const value = previous[key];
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });

  test('POD-OBS: the spawned orchestrator learns the launch home logs.db (the parent universe)', async () => {
    const { logsDbPath } = await import('../mss/logging/log-store.js');
    let stamped: string | undefined;
    dispatchHarnessOnPod({ entrance: 'cli-harness-say', input: 'goal', seat: 'MK' }, {
      run: (_command, _args, env) => { stamped = env.ELANOUS_POD_REEMIT_LOGS_DB; return 0; },
    });
    expect(stamped).toBe(logsDbPath());
  });

  test('routes to the one pod path (orchestrate --substrate pod), keeping the harness completion default', () => {
    const args = podOrchestrateArgs({ entrance: 'cli-harness-say', input: 'x', podPool: 'pool-node-b@node-b:4' }, 'x');
    expect(args.slice(1, 5)).toEqual(['self', 'orchestrate', '--goal-file', 'x']);
    expect(args).toContain('--substrate');
    expect(args[args.indexOf('--substrate') + 1]).toBe('pod');
    expect(args[args.indexOf('--pod-pool') + 1]).toBe('pool-node-b@node-b:4');
    expect(args).toContain('--auto-merge');
    const noMerge = podOrchestrateArgs({ entrance: 'cli-harness-say', input: 'x', autoMerge: false }, 'x');
    expect(noMerge).toContain('--open-pr');
    expect(noMerge).not.toContain('--auto-merge');
    expect(noMerge).not.toContain('--pod-pool');   // 풀은 오케스트레이터가 인자 → 환경 → 설정 순으로 푼다
  });

  test('mbp pool alias reaches the installed k3d context with capacity at most two', () => {
    expect(resolveHarnessPodPool('pool-mbp@mbp:2')).toBe('k3d-monad-h1:2');
    expect(parsePodPool(resolveHarnessPodPool('pool-mbp@mbp:2')!)).toMatchObject([{ context: 'k3d-monad-h1', capacity: 2 }]);
    expect(resolveHarnessPodPool('pool-node-b@node-b:4,pool-mbp@mbp:1')).toBe('pool-node-b@node-b:4,k3d-monad-h1:1');
    const args = podOrchestrateArgs({ entrance: 'cli-harness-say', input: 'goal', podPool: 'pool-mbp@mbp:2' }, 'goal.txt');
    expect(args[args.indexOf('--pod-pool') + 1]).toBe('k3d-monad-h1:2');
    for (const pool of ['pool-mbp@mbp:8', 'k3d-monad-h1:8', 'pool-mbp@mbp:0']) {
      expect(() => resolveHarnessPodPool(pool)).toThrow('mbp Pod 풀 상한은 1~2');
    }
    for (const pool of ['pool-mbp@mbp', 'k3d-monad-h1']) {
      expect(() => resolveHarnessPodPool(pool)).toThrow('mbp Pod 풀 스펙 오류');
    }
    for (const pool of ['pool-mbp@mbp:2,pool-mbp@mbp:2', 'pool-mbp@mbp:2,k3d-monad-h1:1']) {
      expect(() => resolveHarnessPodPool(pool)).toThrow('mbp Pod 풀 합산 상한은 2');
    }
    expect(() => resolveHarnessPodPool('pool-mbp@mbp:1,k3d-monad-h1:1')).toThrow('mbp Pod 풀 컨텍스트 중복');
    expect(resolveHarnessPodPool('pool-node-b@node-b:4')).toBe('pool-node-b@node-b:4');
    expect(resolveHarnessPodPool('k3d-monad-h10:1')).toBe('k3d-monad-h10:1');
    expect(resolveHarnessPodPool('pool-mbp@mbp2:1')).toBe('pool-mbp@mbp2:1');
    expect(resolveHarnessPodPool(undefined)).toBeUndefined();
  });

  test('mbp pool over-capacity is refused before child launch; other pools preserve inherited source', () => {
    const previous = process.env.ELANOUS_POD_SOURCE_VIA;
    process.env.ELANOUS_POD_SOURCE_VIA = 'inherited-source';
    const stderr = spyOn(console, 'error').mockImplementation(() => {});
    const seen: Array<{ args: readonly string[]; source: string | undefined }> = [];
    const run = (_cmd: string, args: readonly string[], env: NodeJS.ProcessEnv) => {
      seen.push({ args, source: env.ELANOUS_POD_SOURCE_VIA }); return 0;
    };
    try {
      expect(dispatchHarnessOnPod({ entrance: 'cli-harness-say', input: 'goal', podPool: 'pool-mbp@mbp:8' }, { run })).toBe(2);
      expect(dispatchHarnessOnPod({ entrance: 'cli-harness-say', input: 'goal', podPool: 'pool-mbp@mbp:2,k3d-monad-h1:1' }, { run })).toBe(2);
      expect(dispatchHarnessOnPod({ entrance: 'cli-harness-say', input: 'goal', podPool: 'pool-mbp@mbp' }, { run })).toBe(2);
      expect(seen).toHaveLength(0);
      expect(dispatchHarnessOnPod({ entrance: 'cli-harness-say', input: 'goal', podPool: 'pool-node-b@node-b:4' }, { run })).toBe(0);
      expect(seen[0]?.source).toBe('inherited-source');
      expect(seen[0]?.args[seen[0]!.args.indexOf('--pod-pool') + 1]).toBe('pool-node-b@node-b:4');
      expect(dispatchHarnessOnPod({ entrance: 'cli-harness-say', input: 'goal', podPool: 'pool-mbp@mbp:2' }, { run })).toBe(0);
      expect(seen[1]?.args[seen[1]!.args.indexOf('--pod-pool') + 1]).toBe('k3d-monad-h1:2');
    } finally {
      stderr.mockRestore();
      if (previous === undefined) delete process.env.ELANOUS_POD_SOURCE_VIA;
      else process.env.ELANOUS_POD_SOURCE_VIA = previous;
    }
  });

  test('ask carries a repository-relative goal document only for files inside the repository; say never carries it', () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-dispatch-'));
    const outside = mkdtempSync(join(tmpdir(), 'pod-outside-'));
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      execFileSync('git', ['init', '-q', root]);
      mkdirSync(join(root, 'docs', 'goals'), { recursive: true });
      writeFileSync(join(root, 'docs', 'goals', 'ASK-x.md'), '# ask');
      writeFileSync(join(outside, 'ASK-y.md'), '# outside');
      symlinkSync(join(outside, 'ASK-y.md'), join(root, 'docs', 'goals', 'ASK-link.md'));
      const seen: Array<NodeJS.ProcessEnv> = [];
      const run = (_cmd: string, _args: readonly string[], env: NodeJS.ProcessEnv) => { seen.push(env); return 0; };
      dispatchHarnessOnPod({ entrance: 'cli-harness-ask', input: 'docs/goals/ASK-x.md' }, { cwd: root, run });
      expect(seen[0]?.ELANOUS_POD_GOAL_DOC).toBe('docs/goals/ASK-x.md');
      dispatchHarnessOnPod({ entrance: 'cli-harness-say', input: 'fix it' }, { cwd: root, run });
      expect(seen[1]?.ELANOUS_POD_GOAL_DOC).toBeUndefined();
      dispatchHarnessOnPod({ entrance: 'cli-harness-ask', input: join(outside, 'ASK-y.md') }, { cwd: root, run });
      expect(seen[2]?.ELANOUS_POD_GOAL_DOC).toBeUndefined();
      dispatchHarnessOnPod({ entrance: 'cli-harness-ask', input: 'docs/goals/ASK-link.md' }, { cwd: root, run });
      expect(seen[3]?.ELANOUS_POD_GOAL_DOC).toBeUndefined();
      expect(log).toHaveBeenCalledWith('harness.substrate', 'goal-doc-outside-repo', { path: join(outside, 'ASK-y.md') });
    } finally { log.mockRestore(); rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
  });

  test('source pr:20785 is forwarded as --pod-source; a bogus spec never calls run and returns 2', () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-source-dispatch-'));
    try {
      execFileSync('git', ['init', '-q', root]);
      mkdirSync(join(root, 'docs', 'goals'), { recursive: true });
      writeFileSync(join(root, 'docs', 'goals', 'ASK-x.md'), '# ask');
      const seen: string[][] = [];
      const run = (_c: string, a: readonly string[]) => { seen.push([...a]); return 0; };
      const ok = dispatchHarnessOnPod({ entrance: 'cli-harness-ask', input: 'docs/goals/ASK-x.md', source: 'pr:20785' }, { cwd: root, run });
      expect(ok).toBe(0);
      expect(seen).toHaveLength(1);
      const at = seen[0]!.indexOf('--pod-source');
      expect(at).toBeGreaterThanOrEqual(0);
      expect(seen[0]![at + 1]).toBe('pr:20785');
      const refused = dispatchHarnessOnPod({ entrance: 'cli-harness-ask', input: 'docs/goals/ASK-x.md', source: 'bogus' }, { cwd: root, run });
      expect(refused).toBe(2);
      expect(seen).toHaveLength(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('repair dispatch pins the PR source, skips author and PR flags, and refuses unsafe inputs', () => {
    const head = 'a'.repeat(40);
    const args = podOrchestrateArgs({ entrance: 'cli-harness-say', input: 'fix', source: 'pr:42', repairCommitOnly: head }, 'goal.txt');
    expect(args).toContain('--repair-commit-only');
    expect(args[args.indexOf('--repair-commit-only') + 1]).toBe(head);
    expect(args[args.indexOf('--base') + 1]).toBe('pr-42');
    expect(args).not.toContain('--open-pr');
    expect(args).not.toContain('--auto-merge');
    const seen: Array<{ args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
    const run = (_cmd: string, childArgs: readonly string[], env: NodeJS.ProcessEnv) => {
      seen.push({ args: childArgs, env }); return 0;
    };
    expect(dispatchHarnessOnPod({ entrance: 'cli-harness-say', input: 'fix', source: 'pr:42', repairCommitOnly: head, authorOnPod: true }, { run })).toBe(0);
    expect(seen[0]?.env.ELANOUS_POD_AUTHOR_ON_POD).toBeUndefined();
    expect(seen[0]?.env.ELANOUS_POD_GOAL_DOC).toBeUndefined();
    expect(dispatchHarnessOnPod({ entrance: 'cli-harness-say', input: 'fix', source: 'commit:' + head, repairCommitOnly: head }, { run })).toBe(2);
    expect(dispatchHarnessOnPod({ entrance: 'cli-harness-say', input: 'fix', source: 'pr:42', repairCommitOnly: head, autoMerge: true }, { run })).toBe(2);
    expect(seen).toHaveLength(1);
  });

  test('repair flag at the public say entrance requires a PR source before any local run', () => {
    const entry = new URL('../../bin/elanous.mjs', import.meta.url).pathname;
    const root = mkdtempSync(join(tmpdir(), 'pod-repair-cli-'));
    const env = { ...process.env, ELANOUS_STATE_DIR: join(root, 'state'), ELANOUS_CONFIG_DIR: join(root, 'config'), ELANOUS_POD_POOL: 'test-pool' };
    try {
      const result = spawnSync(process.execPath, [entry, '--test', 'harness', 'say', '--repair-commit-only', 'a'.repeat(40), '--dry-run', 'fix'],
        { encoding: 'utf8', timeout: 60_000, env });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('--repair-commit-only requires --substrate pod --source pr:N');
      const valid = spawnSync(process.execPath, [entry, '--test', 'harness', 'say', '--substrate', 'pod', '--source', 'pr:42',
        '--repair-commit-only', 'a'.repeat(40), '--no-auto-merge', '--dry-run', 'fix'], { encoding: 'utf8', timeout: 60_000, env });
      expect(valid.status).toBe(0);
      expect(valid.stdout).toContain(`[dry-run] repair forwarding: --pod-source pr:42 --repair-commit-only ${'a'.repeat(40)} --no-auto-merge`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('ask passes only its document path; say writes private goal text for the duration of the child', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-goal-path-'));
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      execFileSync('git', ['init', '-q', root]);
      const goal = join(root, 'goal.md');
      writeFileSync(goal, '판정 신호: bun test');
      const ask = dispatchHarnessOnPod({ entrance: 'cli-harness-ask', input: goal }, {
        cwd: root, run: (_cmd, args) => {
          expect(args).toContain(goal);
          expect(args.join(' ')).not.toContain('판정 신호');
          return 0;
        },
      });
      expect(ask).toBe(0);
      let tempFile = '';
      const sayGoal = '판정 신호: bun test ;; preserve the separator';
      const say = dispatchHarnessOnPod({ entrance: 'cli-harness-say', input: sayGoal }, {
        cwd: root, run: (_cmd, args) => {
          expect(args.join(' ')).not.toContain('판정 신호');
          tempFile = args[args.indexOf('--goal-file') + 1]!;
          expect(readFileSync(tempFile, 'utf8')).toBe(sayGoal);
          expect(execFileSync(process.execPath, ['-e', 'process.stdout.write(require("node:fs").readFileSync(process.argv.at(-1), "utf8"))', tempFile], { encoding: 'utf8' })).toBe(sayGoal);
          expect(statSync(tempFile).mode & 0o777).toBe(0o600);
          return 0;
        },
      });
      expect(say).toBe(0);
      expect(() => statSync(tempFile)).toThrow();
      expect(log).toHaveBeenCalledWith('harness.substrate', 'goal-file', { entrance: 'cli-harness-ask', mode: 'path' });
      expect(log).toHaveBeenCalledWith('harness.substrate', 'goal-file', { entrance: 'cli-harness-say', mode: 'temp' });
    } finally { log.mockRestore(); rmSync(root, { recursive: true, force: true }); }
  });

  test('say leaves occupied new-path validation to the Pod in this partial landing', () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-new-path-preflight-'));
    let origin: string | undefined;
    try {
      execFileSync('git', ['init', '-q', root]);
      mkdirSync(join(root, 'src'));
      writeFileSync(join(root, 'src', 'existing.ts'), 'export {};');
      mkdirSync(join(root, 'src', 'taken.ts'));
      writeFileSync(join(root, 'src', 'taken.ts', 'child.ts'), 'export {};');
      symlinkSync(join(root, 'src', 'existing.ts'), join(root, 'src', 'link.ts'));
      origin = matchDefaultPodSource(root);
      const input = '대상 경로: src/existing.ts\n신설: src/existing.ts';
      const seen: string[][] = [];
      const deps = { cwd: root, recordRunLedgerEntry: (_entry: RunLedgerEntry) => {},
        run: (_command: string, args: readonly string[]) => { seen.push([...args]); return 0; } };
      expect(dispatchHarnessOnPod({ entrance: 'cli-harness-say', input, authorOnPod: true }, deps)).toBe(0);
      expect(dispatchHarnessOnPod({ entrance: 'cli-harness-say', input: '신설: src/taken.ts', authorOnPod: true }, deps)).toBe(0);
      expect(dispatchHarnessOnPod({ entrance: 'cli-harness-say', input: '신설: src/link.ts', authorOnPod: true }, deps)).toBe(0);
      expect(seen).toHaveLength(3);
      expect(seen.every((args) => !args.includes('--pod-source'))).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); if (origin) rmSync(origin, { recursive: true, force: true }); }
  });

  test('ask checks occupied new paths only in the Original ask and TRACED PATHS intersection', () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-new-path-ask-'));
    let origin: string | undefined;
    try {
      execFileSync('git', ['init', '-q', root]);
      mkdirSync(join(root, 'src'));
      writeFileSync(join(root, 'src', 'existing.ts'), 'export {};');
      origin = matchDefaultPodSource(root);
      const goal = join(root, 'goal.md');
      const document = (ask: string, path = 'src/existing.ts') => `Original ask (verbatim, unmodified):\n\`\`\`\n${ask}\n\`\`\`\n## TRACED PATHS\n- ${path}\n`;
      writeFileSync(goal, document('신설: src/existing.ts'));
      let launches = 0;
      let launchArgs: string[] = [];
      const deps = { cwd: root, onOutput: () => {}, recordRunLedgerEntry: () => {}, run: (_command: string, args: readonly string[]) => { launches++; launchArgs = [...args]; return 0; } };
      expect(dispatchHarnessOnPod({ entrance: 'cli-harness-ask', input: goal }, deps)).toBe(2);
      expect(launches).toBe(0);
      writeFileSync(goal, document('신설: src/fresh.ts', 'src/fresh.ts'));
      expect(dispatchHarnessOnPod({ entrance: 'cli-harness-ask', input: goal }, deps)).toBe(0);
      expect(launches).toBe(1);
      expect(launchArgs.slice(launchArgs.indexOf('--pod-source'), launchArgs.indexOf('--pod-source') + 2)).toEqual([
        '--pod-source', `commit:${execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()}`,
      ]);
      const verified = launchArgs[launchArgs.indexOf('--pod-source') + 1]!.slice('commit:'.length);
      const moved = mkdtempSync(join(tmpdir(), 'pod-new-path-moved-origin-'));
      const podCwd = mkdtempSync(join(tmpdir(), 'pod-new-path-source-resolution-'));
      try {
        execFileSync('git', ['clone', '-q', origin, moved]);
        execFileSync('git', ['-C', moved, 'config', 'user.name', 'Pod source test']);
        execFileSync('git', ['-C', moved, 'config', 'user.email', 'pod-source@example.invalid']);
        writeFileSync(join(moved, 'later.ts'), 'export {};');
        execFileSync('git', ['-C', moved, 'add', 'later.ts']);
        execFileSync('git', ['-C', moved, 'commit', '-qm', 'move default HEAD']);
        execFileSync('git', ['-C', moved, 'push', '-q', 'origin', 'HEAD:main']);
        const resolved = Bun.spawnSync(['bash', '-c', `set -e\n${podSourceScript({ kind: 'commit', sha: verified }, origin)}`], { cwd: podCwd });
        expect(resolved.exitCode, resolved.stderr.toString()).toBe(0);
        expect(resolved.stdout.toString()).toContain(`ELANOUS_POD_SOURCE commit ${verified}`);
        expect(execFileSync('git', ['-C', join(podCwd, 'repo'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(verified);
      } finally {
        rmSync(moved, { recursive: true, force: true });
        rmSync(podCwd, { recursive: true, force: true });
      }
    } finally { rmSync(root, { recursive: true, force: true }); if (origin) rmSync(origin, { recursive: true, force: true }); }
  });

  test('real spawned orchestrator stdout reaches the CLI observer without changing its exit status', async () => {
    const output: string[] = [];
    const stdout = spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const status = await dispatchHarnessOnPod({ entrance: 'cli-harness-say', input: 'x' }, {
        spawnChild: ((_cmd, _args, _opts) => spawn(process.execPath, ['-e', 'process.stdout.write("[result] pod-job-failed\\n"); process.exit(1)'], { stdio: ['ignore', 'pipe', 'ignore'] })) as typeof spawn,
        onOutput: (chunk) => output.push(chunk),
      });
      expect(status).toBe(1);
      expect(output.join('')).toBe('[result] pod-job-failed\n');
      expect(stdout).toHaveBeenCalled();
    } finally { stdout.mockRestore(); }
  });

  test('host dispatch marker travels to the orchestrator without changing Pod arguments', () => {
    let seen: NodeJS.ProcessEnv | undefined;
    const input = { entrance: 'cli-harness-say' as const, input: 'fix it', dispatchRecorded: true };
    const run = (_cmd: string, _args: readonly string[], env: NodeJS.ProcessEnv) => { seen = env; return 0; };
    expect(dispatchHarnessOnPod(input, { run })).toBe(0);
    expect(seen?.ELANOUS_DISPATCH_RECORDED).toBe('1');
    expect(podOrchestrateArgs(input, 'fix it')).toEqual(podOrchestrateArgs({ entrance: 'cli-harness-say', input: 'fix it' }, 'fix it'));
  });

  test('--after travels as ELANOUS_POD_AFTER and a stale host value never leaks into an unrelated launch', () => {
    const previous = process.env.ELANOUS_POD_AFTER;
    process.env.ELANOUS_POD_AFTER = '#999';
    try {
      const seen: Array<string | undefined> = [];
      const run = (_cmd: string, _args: readonly string[], env: NodeJS.ProcessEnv) => { seen.push(env.ELANOUS_POD_AFTER); return 0; };
      expect(dispatchHarnessOnPod({ entrance: 'cli-harness-say', input: 'fix it', after: '#123' }, { run })).toBe(0);
      expect(dispatchHarnessOnPod({ entrance: 'cli-harness-say', input: 'fix it' }, { run })).toBe(0);
      expect(seen).toEqual(['#123', undefined]);
    } finally {
      if (previous === undefined) delete process.env.ELANOUS_POD_AFTER;
      else process.env.ELANOUS_POD_AFTER = previous;
    }
  });

  test('unrecorded dispatch never inherits a stale host marker', () => {
    const previous = process.env.ELANOUS_DISPATCH_RECORDED;
    process.env.ELANOUS_DISPATCH_RECORDED = '1';
    try {
      let observed: string | undefined;
      const input = { entrance: 'cli-harness-say' as const, input: 'fix it' };
      expect(dispatchHarnessOnPod(input, { run: (_cmd, _args, env) => {
        observed = env.ELANOUS_DISPATCH_RECORDED;
        return 0;
      } })).toBe(0);
      expect(observed).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.ELANOUS_DISPATCH_RECORDED;
      else process.env.ELANOUS_DISPATCH_RECORDED = previous;
    }
  });

  test('authorOnPod hands the verbatim sentence to the Pod, marks the run and writes nothing under docs/goals', () => {
    const sentence = 'fix the pod author path';
    const seen: { args: string[]; env: NodeJS.ProcessEnv; body: string }[] = [];
    const before = existsSync(join(process.cwd(), 'docs', 'goals')) ? readdirSync(join(process.cwd(), 'docs', 'goals')).filter((n) => n.startsWith('.pod-author-')).length : 0;
    const status = dispatchHarnessOnPod({ entrance: 'cli-harness-say', input: sentence, authorOnPod: true }, {
      run: (_c, args, env) => { seen.push({ args: [...args], env: { ...env }, body: readFileSync(args[args.indexOf('--goal-file') + 1]!, 'utf8') }); return 0; },
    });
    expect(status).toBe(0);
    expect(seen[0]!.body).toBe(sentence);
    expect(seen[0]!.args).not.toContain(sentence);
    expect(seen[0]!.env.ELANOUS_POD_AUTHOR_ON_POD).toBe('1');
    expect(seen[0]!.env.ELANOUS_POD_GOAL_DOC).toBeUndefined();
    expect(seen[0]!.env[HARNESS_RUN_ID_ENV]).toMatch(/^run-/);
    const after = existsSync(join(process.cwd(), 'docs', 'goals')) ? readdirSync(join(process.cwd(), 'docs', 'goals')).filter((n) => n.startsWith('.pod-author-')).length : 0;
    expect(after).toBe(before);
    expect(existsSync(seen[0]!.args[seen[0]!.args.indexOf('--goal-file') + 1]!)).toBe(false);
  });

  test('authorOnPod carries host grade and source through the dispatch environment', () => {
    let env: NodeJS.ProcessEnv = {};
    dispatchHarnessOnPod({ entrance: 'cli-harness-say', input: 'same sentence', authorOnPod: true, authorGrade: 'lite', authorGradeSource: 'config' }, {
      run: (_command, _args, supplied) => { env = { ...supplied }; return 0; },
    });
    expect(env.ELANOUS_POD_AUTHOR_GRADE).toBe('lite');
    expect(env.ELANOUS_POD_AUTHOR_GRADE_SOURCE).toBe('config');
  });

  test('authorOnPod off keeps the raw sentence file', () => {
    let body = '';
    dispatchHarnessOnPod({ entrance: 'cli-harness-say', input: 'plain sentence' }, {
      run: (_c, args) => { body = readFileSync(args[args.indexOf('--goal-file') + 1]!, 'utf8'); return 0; },
    });
    expect(body).toBe('plain sentence');
  });

  test('the exit status of the pod run is the harness exit status', () => {
    const seen: string[][] = [];
    const status = dispatchHarnessOnPod({ entrance: 'cli-harness-say', input: 'fix it' }, { run: (_c, a) => { seen.push([...a]); return 3; } });
    expect(status).toBe(3);
    expect(seen[0]).not.toContain('fix it');
    expect(seen[0]).toContain('--goal-file');
  });
});

describe('child LLM selection reaches the Pod orchestrator (10-05 PODPROVIDER)', () => {
  test('named provider, model and effort are carried to self orchestrate', () => {
    const args = podOrchestrateArgs({ entrance: 'cli-harness-say', input: 'x', childLlmProvider: 'grok', childLlmModel: 'grok-4.7', childLlmEffort: 'high' }, 'x');
    expect(args.slice(args.indexOf('--child-llm-provider'), args.indexOf('--child-llm-provider') + 6))
      .toEqual(['--child-llm-provider', 'grok', '--child-llm-model', 'grok-4.7', '--child-llm-effort', 'high']);
  });
  test('without a named provider the args are unchanged', () => {
    const args = podOrchestrateArgs({ entrance: 'cli-harness-say', input: 'x' }, 'x');
    expect(args.some((arg) => arg.startsWith('--child-llm'))).toBe(false);
  });
});
