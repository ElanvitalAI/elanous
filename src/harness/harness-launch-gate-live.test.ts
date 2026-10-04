import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import { expect, spyOn, test } from 'bun:test';
import { debug } from '../debug/log.js';
import { activeRunsForGoal, launchRequestId } from '../execution-loop/launch-gate.js';
import type { QueriedRunningRunsResult } from '../self-implement/running-runs.js';
import { appendRunLedgerEntry } from '../self-implement/run-ledger.js';
import { writeQuotaSignal } from '../budget/codex-reset-credit-state.js';
import { saveTokens } from '../oauth/store.js';

const repo = resolve(import.meta.dir, '../..');

// The child reads its default budget and running-run observation; neither is injected.
test('harness say live launch gate rejects a same-goal active run and observes a forced override', () => {
  const root = mkdtempSync(join(tmpdir(), 'harness-launch-gate-'));
  const home = join(root, 'home');
  const state = join(root, 'instance', '.elanous-test');
  const sentence = `live launch gate ${randomUUID()}`;
  const goalId = launchRequestId(sentence);
  const runId = `run-${randomUUID()}`;
  const dbPath = join(state, 'pty', 'manifest.db');
  let db: Database | undefined;
  try {
    mkdirSync(join(home, '.elanous', 'logs'), { recursive: true });
    mkdirSync(join(state, 'logs'), { recursive: true });
    mkdirSync(join(state, 'pty'), { recursive: true });
    // The federation discovers isolated universes via this registry and the store paths.
    writeFileSync(join(home, '.elanous', 'logs', 'instances.json'), JSON.stringify({ instances: [{ name: 'test:launch-gate', kind: 'test', stateDir: state, configDir: state, pid: process.pid, startedAt: new Date().toISOString() }] }));
    writeFileSync(join(state, 'logs', 'logs.db'), '');
    appendRunLedgerEntry({ runId, goalId, event: 'start', timestamp: new Date().toISOString(), data: {} }, join(state, 'run-ledger'));
    db = new Database(dbPath);
    db.run('CREATE TABLE pty_manifest (id TEXT PRIMARY KEY, kind TEXT, cmd TEXT, owner_pid INTEGER, pty_pid INTEGER, instance TEXT, run_id TEXT, started_at INTEGER, alive INTEGER, updated_at INTEGER)');
    db.query('INSERT INTO pty_manifest (id, kind, cmd, owner_pid, pty_pid, instance, run_id, started_at, alive, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(`pty-${randomUUID()}`, 'shell', 'bun', process.pid, 0, 'test:launch-gate', runId, Date.now(), 1, Date.now());
    db.close();
    db = undefined;

    const childEnv = { PATH: process.env.PATH ?? '', HOME: home, XDG_CONFIG_HOME: join(home, '.config'), NODE_ENV: 'test', ELANOUS_LAUNCH_GATE_LIVE: '1' };
    const execute = (flags: string[] = []) => spawnSync(process.execPath, ['bin/elanous.mjs', `--test=${state}`, 'harness', 'say', sentence, '--child-llm-provider', 'anthropic', ...flags], {
      cwd: repo, env: childEnv, encoding: 'utf8', timeout: 90_000,
    });
    const blocked = execute();
    expect(blocked.error).toBeUndefined();
    expect(blocked.status).toBe(3);
    expect(blocked.stderr.split('\n').filter((line) => line.includes('❌ launch gate:'))).toEqual([
      `❌ launch gate: blocked-duplicate — same-goal active runs: ${runId}`,
    ]);
    expect(blocked.stderr).not.toContain('active runs unknown');
    const unmeasured = spawnSync(process.execPath, [
      'bin/elanous.mjs', `--test=${state}`, 'harness', 'say', `empty home ${randomUUID()}`,
      '--child-llm-provider', 'openai-codex', '--source', 'local-only',
    ], { cwd: repo, env: childEnv, encoding: 'utf8', timeout: 90_000 });
    expect(unmeasured.error).toBeUndefined();
    expect(unmeasured.status).toBe(2);
    expect(unmeasured.stderr.split('\n').filter((line) => line.includes('usage unmeasured'))).toEqual([
      '⚠️ launch gate: budget: openai-codex usage unmeasured — launching',
    ]);
    expect(unmeasured.stderr).toContain('`--source` 는 `--substrate pod` 와 함께');
    expect(unmeasured.stderr).not.toContain('❌ launch gate:');
    const eventsAfterUnmeasured = readFileSync(join(repo, 'log', 'latest'), 'utf8').split('\n').flatMap((line) => {
      try { return [JSON.parse(line) as { category: string; event: string; data: Record<string, unknown> }]; }
      catch { return []; }
    });
    expect(eventsAfterUnmeasured).toContainEqual(expect.objectContaining({
      category: 'execution-loop.launch-gate', event: 'budget-unmeasured', data: { provider: 'openai-codex' },
    }));

    const codexHome = join(home, '.codex');
    saveTokens('openai-codex', { accessToken: 'test', refreshToken: 'test', expiresAt: null },
      { mirrorCodex: false, codexHome }, join(home, '.config', 'elanous', 'auth.json'));
    const previousStateDir = process.env.ELANOUS_STATE_DIR;
    try {
      process.env.ELANOUS_STATE_DIR = state;
      writeQuotaSignal(undefined, 95, codexHome);
    } finally {
      if (previousStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = previousStateDir;
    }
    const budgetBlocked = spawnSync(process.execPath, [
      'bin/elanous.mjs', `--test=${state}`, 'harness', 'say', sentence,
      '--child-llm-provider', 'openai-codex', '--force-gate', '--source', 'local-only',
    ], { cwd: repo, env: childEnv, encoding: 'utf8', timeout: 90_000 });
    expect(budgetBlocked.error).toBeUndefined();
    expect(budgetBlocked.status).toBe(3);
    expect(budgetBlocked.stderr.split('\n').filter((line) => line.includes('❌ launch gate:'))).toEqual([
      '❌ launch gate: blocked-budget — codex: default 95% ≥ 95',
    ]);
    expect(budgetBlocked.stderr).not.toContain('usage unmeasured');

    // --force-gate must visibly record its decision; prevent launching a child with an
    // invalid option, which the launch handler rejects after the gate has decided.
    const forced = execute(['--force-gate', '--source', 'local-only']);
    expect(forced.error).toBeUndefined();
    expect(forced.stderr).not.toContain('active runs unknown');
    expect(forced.stderr).toContain('`--source` 는 `--substrate pod` 와 함께');
    expect(forced.stderr).not.toContain('❌ launch gate:');
    expect(forced.status).toBe(2);
    const events = readFileSync(join(repo, 'log', 'latest'), 'utf8').split('\n').flatMap((line) => {
      try { return [JSON.parse(line) as { category: string; event: string; data: Record<string, unknown> }]; }
      catch { return []; }
    });
    expect(events.filter((row) => row.category === 'execution-loop.launch-gate' && row.event === 'decision').map((row) => row.data))
      .toContainEqual(expect.objectContaining({ goalId, action: 'proceed', sameGoalActiveRuns: [runId], forceLaunch: true }));
  } finally {
    db?.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test('unknown active-run observation records the reason instead of an opaque warning', () => {
  const log = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    const incomplete = {
      completeness: 'complete',
      pty: { unreadable: [] },
      entries: [{ runId: 'run-missing-goal', status: 'running', ledgerDirectories: ['/isolated/run-ledger'], ptyRefs: [{ id: 'pty-live' }] }],
    } as unknown as QueriedRunningRunsResult;
    expect(activeRunsForGoal('request-other', { queryRuns: () => incomplete, loadLedger: () => [
      { runId: 'run-missing-goal', event: 'start', data: {} },
    ] })).toBe('unknown');
    expect(log).toHaveBeenCalledWith('execution-loop.launch-gate', 'active-runs-unknown', {
      goalId: 'request-other', reasons: ['run-missing-goal: expected one goalId, found 0'], skippedTerminal: 0,
    });
  } finally { log.mockRestore(); }
});
