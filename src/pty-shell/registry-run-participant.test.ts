import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repo = new URL('../..', import.meta.url).pathname;

function runParticipantRegistration(stateDir: string, runId?: string, createRun = true, parentStateDir?: string, createParentRun = true): unknown {
  const script = `
    import { startPty, setPtyAdapterForTesting, unregisterPty } from './src/pty-shell/registry.ts';
    import { existsSync } from 'node:fs';
    import { join } from 'node:path';
    import { saveSelfDevRun, loadSelfDevRun, selfDevRunsDir } from './src/self-dev/run-store.ts';
    const runId = process.env.ELANOUS_RUN_ID;
    const parentDir = process.env.ELANOUS_PARENT_SELF_DEV_RUNS_DIR;
    if (runId && ${createRun}) saveSelfDevRun({ runId, createdAt: 1, updatedAt: 1, results: [] });
    if (runId && parentDir && ${createParentRun}) saveSelfDevRun({ runId, createdAt: 1, updatedAt: 1, results: [] }, parentDir);
    setPtyAdapterForTesting(() => ({ pid: 1, write() {}, kill() {}, resize() {}, onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }) }));
    const handle = startPty({ cmd: 'x', detach: true });
    console.log(JSON.stringify({ id: handle.id, run: runId ? loadSelfDevRun(runId) : null, parentRun: runId && parentDir ? loadSelfDevRun(runId, parentDir) : null,
      parentRecordExists: runId && parentDir ? existsSync(join(parentDir, runId + '.json')) : null, localDir: selfDevRunsDir() }));
    unregisterPty(handle.id);
  `;
  // saveSelfDevRun also mirrors to the machine ledger under HOME (#22313); give each child its own.
  const home = mkdtempSync(join(tmpdir(), 'pty-run-participant-home-'));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, NODE_ENV: 'production', ELANOUS_STATE_DIR: stateDir };
  if (runId) env.ELANOUS_RUN_ID = runId;
  else delete env.ELANOUS_RUN_ID;
  if (parentStateDir) env.ELANOUS_PARENT_SELF_DEV_RUNS_DIR = join(parentStateDir, 'self-dev-runs');
  else delete env.ELANOUS_PARENT_SELF_DEV_RUNS_DIR;
  let result: ReturnType<typeof Bun.spawnSync>;
  try {
    result = Bun.spawnSync([process.execPath, '-e', script], {
      cwd: repo,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  expect(result.exitCode).toBe(0);
  return JSON.parse(new TextDecoder().decode(result.stdout));
}

describe('startPty run participant registration', () => {
  test('adds an inherited run PTY participant without changing the manifest gate', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'pty-run-participant-'));
    try {
      const result = runParticipantRegistration(stateDir, 'run-parent') as { id: string; run: { participants?: unknown[] } };
      expect(result.run.participants).toEqual([{
        id: result.id,
        kind: 'pty',
        transports: [{ kind: 'pty', id: result.id }],
        registeredAt: expect.any(Number),
        runIdSource: 'inherited',
      }]);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test('registers an inherited child PTY in both its local and explicit parent run stores', () => {
    const childStateDir = mkdtempSync(join(tmpdir(), 'pty-run-participant-child-'));
    const parentStateDir = mkdtempSync(join(tmpdir(), 'pty-run-participant-parent-'));
    try {
      const result = runParticipantRegistration(childStateDir, 'run-parent', true, parentStateDir) as { id: string; run: { participants?: unknown[] }; parentRun: { participants?: unknown[] } };
      expect(result.run.participants).toEqual([expect.objectContaining({ id: result.id, kind: 'pty', runIdSource: 'inherited' })]);
      expect(result.parentRun.participants).toEqual([expect.objectContaining({ id: result.id, kind: 'pty', runIdSource: 'inherited' })]);
    } finally {
      rmSync(childStateDir, { recursive: true, force: true });
      rmSync(parentStateDir, { recursive: true, force: true });
    }
  });

  test('does not create a missing explicit parent run record', () => {
    const childStateDir = mkdtempSync(join(tmpdir(), 'pty-run-participant-child-'));
    const parentStateDir = mkdtempSync(join(tmpdir(), 'pty-run-participant-parent-missing-'));
    try {
      const result = runParticipantRegistration(childStateDir, 'run-parent-missing', true, parentStateDir, false) as { run: { participants?: unknown[] }; parentRecordExists: boolean };
      expect(result.run.participants).toHaveLength(1);
      // Assert on the parent store itself: loadSelfDevRun falls back to the machine mirror of the
      // child's own record (#22313), which is not a parent record.
      expect(result.parentRecordExists).toBe(false);
      expect(existsSync(join(parentStateDir, 'self-dev-runs', 'run-parent-missing.json'))).toBe(false);
    } finally {
      rmSync(childStateDir, { recursive: true, force: true });
      rmSync(parentStateDir, { recursive: true, force: true });
    }
  });

  test('a PTY outside a run does not create a run record', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'pty-run-participant-none-'));
    try {
      const result = runParticipantRegistration(stateDir) as { run: null };
      expect(result.run).toBeNull();
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test('an inherited run ID without a record does not create a ghost run', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'pty-run-participant-ghost-'));
    try {
      const result = runParticipantRegistration(stateDir, 'run-missing', false) as { run: null };
      expect(result.run).toBeNull();
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
