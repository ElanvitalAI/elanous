import { expect, test } from 'bun:test';
import { podJobManifest } from './self-implement-pod.js';

const baseHead = 'a'.repeat(40);
const args = { name: 'repair-test', namespace: 'elanous-test', image: 'test', repoUrl: 'https://example.test/repo',
  source: { kind: 'pr' as const, number: 42 }, repairCommitOnly: { pr: 42, baseHead },
  args: ['--base', 'pr-42'], passEnv: [], deadlineSeconds: 60, goalDoc: 'docs/goals/old.md', authorSentence: true };

test('repair Pod pins source head, directly implements worktree-only, exports bundle, and never pushes salvage', () => {
  const manifest = podJobManifest(args) as { spec: { template: { spec: { containers: Array<{ args: string[] }> } } } };
  const script = manifest.spec.template.spec.containers[0]!.args[0]!;
  expect(script).toContain(`git rev-parse HEAD)" = '${baseHead}'`);
  expect(script).toContain('elanous self implement "$(cat /creds/feature)" --json --no-open-pr');
  expect(script).toContain("'--base' 'pr-42'");
  expect(script).toContain('elanous self repair-commit-export');
  expect(script).not.toContain('bun src/task-orchestrator/surfaces/pod-repair-commit.ts');
  expect(script).not.toContain('elanous harness ask');
  expect(script).not.toContain('elanous harness say');
  expect(script).not.toContain('git push origin "HEAD:refs/heads/${branch}"');
  expect(script).not.toContain('--open-pr');
});

test('repair manifest refuses different PR source and any PR/merge flag', () => {
  expect(() => podJobManifest({ ...args, source: { kind: 'pr', number: 43 } })).toThrow('matching PR source');
  expect(() => podJobManifest({ ...args, args: ['--open-pr'] })).toThrow('no PR/merge');
});
