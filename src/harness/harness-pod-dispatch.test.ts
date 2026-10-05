import { describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { debug } from '../debug/log.js';
import { authorOnPodGoal, dispatchHarnessOnPod, fenceVerbatimSentence, podOrchestrateArgs } from './harness-pod-dispatch.js';
import { podMemoryLimitFor } from '../task-orchestrator/surfaces/self-implement-pod.js';

describe('harness say/ask --substrate pod', () => {
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

  test('authorOnPod wraps the sentence as a GOAL file and leaves only a receipt', () => {
    const sentence = 'fix the pod author path';
    const seen: string[][] = [];
    const status = dispatchHarnessOnPod({ entrance: 'cli-harness-say', input: sentence, authorOnPod: true }, {
      run: (_c, args) => { seen.push([...args]); return 0; },
    });
    expect(status).toBe(0);
    const goalFile = seen[0]![seen[0]!.indexOf('--goal-file') + 1]!;
    expect(goalFile).toContain('GOAL-pod-author-');
    const doc = readFileSync(goalFile, 'utf8');
    expect(doc).toBe(authorOnPodGoal(sentence));
    expect(doc).toContain('elanous harness say --substrate local');
    expect(doc).toContain(sentence);
    expect(seen[0]).not.toContain(sentence);
    rmSync(goalFile.slice(0, goalFile.lastIndexOf('/')), { recursive: true, force: true });
  });

  test('a sentence that contains fences stays inside one fence', () => {
    const sentence = 'keep ```this``` literal';
    const { fence } = fenceVerbatimSentence(sentence);
    const doc = authorOnPodGoal(sentence);
    expect(fence.length).toBeGreaterThan(3);
    expect(doc.split(fence)).toHaveLength(3);
    expect(doc.split(fence)[1]).toBe(`\n${sentence}\n`);
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
