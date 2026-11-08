import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { getTestStateRoot, setTestStateRoot } from '../nexus/paths.js';
import { createReleaseSimRigFakeGitScript, runReleaseSimRigScenario } from './release-sim-rig.js';
import { resolveScenarioFilePath } from './scenario.js';

function pwaWorktreeScenario(id: string): string {
  const source = readFileSync(resolveScenarioFilePath('scenarios/ux-sim/release-incident-events-execution.yaml'), 'utf8');
  const scenario = parseYaml(source) as { id: string; cases: Array<{ id: string; mode?: string }> };
  scenario.id = id;
  scenario.cases = scenario.cases.filter(({ mode }) => mode === 'pwa-costly-opt-in-required');
  return stringifyYaml(scenario);
}

function fakeGit(root: string, runId: string): { path: string; log: string; run: (args: string[]) => ReturnType<typeof spawnSync> } {
  const path = join(root, 'fake-git');
  const log = join(root, 'worktree-lifecycle.log');
  writeFileSync(path, createReleaseSimRigFakeGitScript());
  chmodSync(path, 0o700);
  writeFileSync(log, '');
  return { path, log, run: (args) => spawnSync(path, args, { encoding: 'utf8', env: {
    ...process.env, ELANOUS_SIM_RIG_RUN_ID: runId, ELANOUS_SIM_RIG_WORKTREE_LOG: log,
  } }) };
}

test('fake Git verifies the current run marker on disk and removes only that worktree', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-sim-teardown-owned-'));
  const runId = 'release-sim-test-80125';
  const worktree = join(root, 'owned-worktree');
  const marker = join(worktree, '.elanous-release-sim-rig');
  const fake = fakeGit(root, runId);
  try {
    const add = fake.run(['worktree', 'add', '--detach', worktree, 'deadbeef']);
    expect(add.status).toBe(0);
    expect(readFileSync(marker, 'utf8')).toBe(`release-sim-rig-worktree-v1\n${runId}\n`);
    expect(readFileSync(join(fake.log), 'utf8').trim().split('\n')).toEqual(['add-marker-verified']);

    const remove = fake.run(['worktree', 'remove', '--force', worktree]);
    expect(remove.status).toBe(0);
    expect(existsSync(worktree)).toBe(false);
    expect(readFileSync(fake.log, 'utf8').trim().split('\n')).toEqual([
      'add-marker-verified', 'remove-marker-matched-path-absent',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fake Git refuses existing unmarked, foreign-run, and non-exact marker paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-sim-teardown-protected-'));
  const runId = 'release-sim-test-80125';
  const fake = fakeGit(root, runId);
  const unmarked = join(root, 'unmarked-worktree');
  const foreign = join(root, 'foreign-run-worktree');
  const malformed = join(root, 'extra-newline-worktree');
  try {
    mkdirSync(unmarked);
    mkdirSync(foreign);
    mkdirSync(malformed);
    writeFileSync(join(foreign, '.elanous-release-sim-rig'), 'release-sim-rig-worktree-v1\nother-run\n');
    writeFileSync(join(malformed, '.elanous-release-sim-rig'), `release-sim-rig-worktree-v1\n${runId}\n\n`);

    for (const path of [unmarked, foreign, malformed]) {
      const add = fake.run(['worktree', 'add', '--detach', path, 'deadbeef']);
      expect(add.status).toBe(1);
      const remove = fake.run(['worktree', 'remove', '--force', path]);
      expect(remove.status).toBe(0);
      expect(existsSync(path)).toBe(true);
    }
    expect(readFileSync(join(foreign, '.elanous-release-sim-rig'), 'utf8')).toBe('release-sim-rig-worktree-v1\nother-run\n');
    expect(readFileSync(join(malformed, '.elanous-release-sim-rig'), 'utf8')).toBe(`release-sim-rig-worktree-v1\n${runId}\n\n`);
    expect(readFileSync(fake.log, 'utf8').trim().split('\n')).toEqual([
      'add-refused-existing', 'remove-preserved-unmarked',
      'add-refused-existing', 'remove-preserved-other-run',
      'add-refused-existing', 'remove-preserved-other-run',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('release sim rig exercises the same fake Git worktree boundary', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-sim-teardown-integration-'));
  const previous = getTestStateRoot();
  const scenarioId = 'release-sim-teardown-integration-80125';
  const worktreeRunId = `release-sim-${scenarioId}-incident-06-pwa-costly-opt-in`;
  setTestStateRoot(root);
  try {
    const result = await runReleaseSimRigScenario(pwaWorktreeScenario(scenarioId));
    expect(result.pass).toBe(true);
    const pwa = result.cases[0]?.injectedEvidence?.pwaNode as { worktreeLifecycle?: string[] } | undefined;
    expect(pwa?.worktreeLifecycle).toEqual(['add-marker-verified', 'remove-marker-matched-path-absent']);
    expect(readFileSync(join(root, `${worktreeRunId}-worktree-marker.snapshot`), 'utf8'))
      .toBe(`release-sim-rig-worktree-v1\n${worktreeRunId}\n`);
    const worktreePath = readFileSync(join(root, `${worktreeRunId}-worktree-path.snapshot`), 'utf8').trim();
    expect(existsSync(worktreePath)).toBe(false);
  } finally {
    setTestStateRoot(previous ?? null);
    rmSync(root, { recursive: true, force: true });
  }
}, 300_000);
