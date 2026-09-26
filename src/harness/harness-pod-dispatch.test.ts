import { describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { debug } from '../debug/log.js';
import { dispatchHarnessOnPod, podGoalText, podOrchestrateArgs } from './harness-pod-dispatch.js';

describe('harness say/ask --substrate pod', () => {
  test('ask ships the goal document CONTENT (a pod cannot see this machine\'s untracked goal file)', () => {
    const text = podGoalText({ entrance: 'cli-harness-ask', input: 'docs/goals/ASK-x.md' }, (p) => `# goal from ${p}\nbody;;tail`);
    expect(text).toBe('# goal from docs/goals/ASK-x.md\nbody; ;tail');   // `;;` 는 오케스트레이터의 골 구분자 — 한 발 = 한 골
  });

  test('routes to the one pod path (orchestrate --substrate pod), keeping the harness completion default', () => {
    const args = podOrchestrateArgs({ entrance: 'cli-harness-say', input: 'x', podPool: 'pool-node-b@node-b:4' }, 'x');
    expect(args.slice(1, 4)).toEqual(['self', 'orchestrate', 'x']);
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

  test('the exit status of the pod run is the harness exit status', () => {
    const seen: string[][] = [];
    const status = dispatchHarnessOnPod({ entrance: 'cli-harness-say', input: 'fix it' }, { run: (_c, a) => { seen.push([...a]); return 3; } });
    expect(status).toBe(3);
    expect(seen[0]).toContain('fix it');
  });
});
