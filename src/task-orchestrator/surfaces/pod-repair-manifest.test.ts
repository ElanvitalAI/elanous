import { expect, test } from 'bun:test';
import { podJobManifest, repairPodExitCode } from './self-implement-pod.js';

const baseHead = 'a'.repeat(40);
const args = { name: 'repair-test', namespace: 'elanous-test', image: 'test', repoUrl: 'https://example.test/repo',
  source: { kind: 'pr' as const, number: 42 }, repairCommitOnly: { pr: 42, baseHead },
  args: ['--base', 'pr-42'], passEnv: [], deadlineSeconds: 60, goalDoc: 'docs/goals/old.md', authorSentence: true };

test('repair Pod pins source head, directly implements worktree-only, exports bundle, and never pushes salvage', () => {
  const manifest = podJobManifest(args) as { spec: { template: { spec: { containers: Array<{ args: string[] }> } } } };
  const script = manifest.spec.template.spec.containers[0]!.args[0]!;
  expect(script).toContain(`git rev-parse HEAD)" = '${baseHead}'`);
  expect(script).toContain('export ELANOUS_POD_VERIFIED_PR_SOURCE=1');
  expect(script.indexOf('export ELANOUS_POD_VERIFIED_PR_SOURCE=1')).toBeGreaterThan(script.indexOf('ELANOUS_POD_SOURCE pr'));
  expect(script.indexOf('export ELANOUS_POD_VERIFIED_PR_SOURCE=1')).toBeGreaterThan(script.indexOf(`git rev-parse HEAD)" = '${baseHead}'`));
  expect(script).toContain('elanous self implement "$(cat /creds/feature)" --json --no-open-pr');
  expect(script).toContain("'--base' 'pr-42'");
  expect(script).toContain('elanous self repair-commit-export');
  expect(script).toContain('if elanous self repair-commit-export');
  expect(script).toContain('then rc=0; elif [ "$rc" -eq 0 ]; then rc=8; fi');
  expect(script).not.toContain('if [ "$rc" -eq 0 ]; then elanous self repair-commit-export');
  expect(script).not.toContain('bun src/task-orchestrator/surfaces/pod-repair-commit.ts');
  expect(script).not.toContain('elanous harness ask');
  expect(script).not.toContain('elanous harness say');
  expect(script).not.toContain('git push origin "HEAD:refs/heads/${branch}"');
  expect(script).not.toContain('--open-pr');
});

test('ordinary Pod supervision has no verified PR-source marker', () => {
  const manifest = podJobManifest({ ...args, source: { kind: 'default' }, repairCommitOnly: undefined }) as { spec: { template: { spec: { containers: Array<{ args: string[] }> } } } };
  expect(manifest.spec.template.spec.containers[0]!.args[0]!).not.toContain('ELANOUS_POD_VERIFIED_PR_SOURCE');
});

test('PR source without a repair pin still marks its verified checkout before the child runs', () => {
  const manifest = podJobManifest({ ...args, repairCommitOnly: undefined }) as { spec: { template: { spec: { containers: Array<{ args: string[] }> } } } };
  const script = manifest.spec.template.spec.containers[0]!.args[0]!;
  expect(script).toContain('export ELANOUS_POD_VERIFIED_PR_SOURCE=1');
  expect(script.indexOf('export ELANOUS_POD_VERIFIED_PR_SOURCE=1')).toBeGreaterThan(script.indexOf('ELANOUS_POD_SOURCE pr'));
  expect(script.indexOf('export ELANOUS_POD_VERIFIED_PR_SOURCE=1')).toBeLessThan(script.indexOf('elanous harness say'));
});

test('repair manifest refuses different PR source and any PR/merge flag', () => {
  expect(() => podJobManifest({ ...args, source: { kind: 'pr', number: 43 } })).toThrow('matching PR source');
  expect(() => podJobManifest({ ...args, args: ['--open-pr'] })).toThrow('no PR/merge');
});

test('host accepts a failed repair child only after the artifact collector verifies its bundle', () => {
  const failedChild = { stage: 'gate-failed', ok: false };
  expect(repairPodExitCode({ state: 'complete', repairCommitOnly: true,
    repairArtifactReady: false, disposition: failedChild })).toBe(1);
  expect(repairPodExitCode({ state: 'complete', repairCommitOnly: true,
    repairArtifactReady: true, disposition: failedChild })).toBe(0);
  expect(repairPodExitCode({ state: 'failed', repairCommitOnly: true,
    repairArtifactReady: true, disposition: failedChild })).toBe(1);
  expect(repairPodExitCode({ state: 'complete', repairCommitOnly: false,
    repairArtifactReady: true, disposition: failedChild })).toBe(1);
});
