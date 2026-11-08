import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { activeRunsForGoal, decideLaunchDoor, launchRequestId, preLaunchGate, resolveLaunchDoorEnv } from '../execution-loop/launch-gate.js';
import { appendRunLedgerEntry } from '../self-implement/run-ledger.js';
import { simCli } from '../ux-sim/in-process-cli.js';

const repo = resolve(import.meta.dir, '../..');

async function say(extraEnv: Record<string, string> = {}, flags: string[] = [], activeDuplicate = false, mode: 'in-process' | 'spawn' = 'in-process') {
  const root = mkdtempSync(join(tmpdir(), 'launch-door-env-'));
  try {
    const state = join(root, 'state');
    const sentence = `launch door ${randomUUID()}\n대상 경로: src/harness/launch-door-env.test.ts`;
    let duplicateRunId: string | undefined;
    let activeDuplicateRuns: readonly string[] = [];
    if (activeDuplicate) {
      const runId = duplicateRunId = `run-${randomUUID()}`;
      const ledgerDir = join(state, 'run-ledger');
      const home = join(root, 'home');
      mkdirSync(join(home, '.elanous', 'logs'), { recursive: true });
      mkdirSync(join(state, 'logs'), { recursive: true });
      mkdirSync(join(state, 'pty'), { recursive: true });
      writeFileSync(join(home, '.elanous', 'logs', 'instances.json'), JSON.stringify({ instances: [{ name: 'test:launch-door', kind: 'test', stateDir: state, configDir: state, pid: process.pid, startedAt: new Date().toISOString() }] }));
      writeFileSync(join(state, 'logs', 'logs.db'), '');
      appendRunLedgerEntry({ runId, goalId: launchRequestId(sentence), event: 'start', timestamp: new Date().toISOString(), data: {} }, ledgerDir);
      const db = new Database(join(state, 'pty', 'manifest.db'));
      db.run('CREATE TABLE pty_manifest (id TEXT PRIMARY KEY, kind TEXT, cmd TEXT, owner_pid INTEGER, pty_pid INTEGER, instance TEXT, run_id TEXT, started_at INTEGER, alive INTEGER, updated_at INTEGER)');
      db.query('INSERT INTO pty_manifest (id, kind, cmd, owner_pid, pty_pid, instance, run_id, started_at, alive, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(`pty-${randomUUID()}`, 'shell', 'bun', process.pid, 0, 'test:launch-door', runId, Date.now(), 1, Date.now());
      db.close();
      activeDuplicateRuns = activeRunsForGoal(launchRequestId(sentence), {
        queryRuns: () => ({ completeness: 'complete', pty: { unreadable: [] }, entries: [{ runId, status: 'running', ledgerDirectories: [ledgerDir], ptyRefs: [{ id: `pty-${runId}` }] }] }) as never,
        loadLedger: () => [{ runId, goalId: launchRequestId(sentence), event: 'start', data: {} }] as never,
      }) as readonly string[];
    }
    const result = await simCli([
      `--test=${state}`, 'harness', 'say', sentence,
      '--child-llm-provider', 'anthropic', '--substrate', 'local', '--no-queue', ...flags,
    ], {
      mode, allowPaths: [['harness', 'say']], stateRoot: state, cwd: repo,
      ...(mode === 'spawn' ? { timeoutMs: 90_000 } : {}),
      env: {
        PATH: process.env.PATH ?? '', HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'config'),
        NODE_ENV: 'test', ELANOUS_LAUNCH_GATE_LIVE: '1',
        ...extraEnv,
      },
    });
    const ledgerDir = join(state, 'run-ledger');
    const runLedgers = existsSync(ledgerDir) ? readdirSync(ledgerDir).filter((name) => name.endsWith('.jsonl')) : [];
    const requestId = launchRequestId(sentence);
    const launchDoorDecisions = (() => {
      const logDir = join(repo, 'log');
      if (!existsSync(logDir)) return [];
      return readdirSync(logDir).filter((name) => name.startsWith('debug-') && name.endsWith('.log'))
        .flatMap((name) => readFileSync(join(logDir, name), 'utf8').split('\n').flatMap((line) => {
          try {
            const row = JSON.parse(line) as { category?: string; event?: string; data?: Record<string, unknown> };
            return row.category === 'execution-loop.launch-door' && row.event === 'decision' && row.data?.goalId === requestId ? [row.data] : [];
          } catch { return []; }
        }));
    })();
    const launchStamps = runLedgers.flatMap((name) => readFileSync(join(ledgerDir, name), 'utf8').split('\n').flatMap((line) => {
      try {
        const entry = JSON.parse(line) as { event?: string; data?: { launch?: unknown } };
        return entry.event === 'run-origin' && entry.data?.launch ? [entry.data.launch] : [];
      } catch { return []; }
    }));
    return { ...result, runLedgers, launchStamps, launchDoorDecisions, duplicateRunId, activeDuplicateRuns };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('default shadow records the launch door without refusing before dispatch', async () => {
  const result = await say({}, [], false, 'spawn');
  expect(result.stderr).not.toContain('launch door: blocked');
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain('No LLM provider available');
  expect(result.runLedgers.length).toBeGreaterThan(0);
  expect(result.launchStamps).toHaveLength(0);
  expect(result.launchDoorDecisions).toEqual(expect.arrayContaining([
    expect.objectContaining({ mode: 'shadow', modeSource: 'default', allowed: false, wouldReject: true }),
  ]));
}, 300_000);

test('default and empty modes use shadow while explicit permission and signal remain allowed', async () => {
  const permission = { ELANOUS_LAUNCH_DOOR_PERMISSION: 'allow', ELANOUS_LAUNCH_DOOR_SIGNAL: 'green' };
  for (const env of [permission, { ...permission, ELANOUS_LAUNCH_DOOR_MODE: '' }]) {
    const resolved = resolveLaunchDoorEnv(env);
    expect(resolved.mode).toBe('shadow');
    expect(decideLaunchDoor({ entrance: 'harness-say', actor: 'DOOR', viaQueue: false }, resolved).allowed).toBe(true);
  }
  const emptyMode = await say({ ...permission, ELANOUS_LAUNCH_DOOR_MODE: '' });
  expect(emptyMode.stderr).not.toContain('launch door: blocked');
  expect(emptyMode.exitCode).toBe(1);
  expect(emptyMode.runLedgers.length).toBeGreaterThan(0);
  expect(emptyMode.launchStamps).toHaveLength(0);
  expect(emptyMode.launchDoorDecisions).toEqual(expect.arrayContaining([
    expect.objectContaining({ mode: 'shadow', modeSource: 'default', allowed: true, wouldReject: false }),
  ]));
}, 300_000);

test('enforce refuses before dispatch with an explicit status and reason, even when --force-gate would bypass a duplicate', async () => {
  for (const flags of [[], ['--force-gate']]) {
    const result = await say({ ELANOUS_LAUNCH_DOOR_MODE: 'enforce' }, flags, true);
    expect(result.duplicateRunId).toBeDefined();
    expect(result.activeDuplicateRuns).toEqual([result.duplicateRunId!]);
    const duplicate = preLaunchGate({ goalId: 'same-goal', budget: { action: 'proceed', reasons: [] } }, { activeRuns: () => result.activeDuplicateRuns });
    const forcedDuplicate = preLaunchGate({ goalId: 'same-goal', budget: { action: 'proceed', reasons: [] }, forceLaunch: true }, { activeRuns: () => result.activeDuplicateRuns });
    expect(duplicate.action).toBe('blocked-duplicate');
    expect(forcedDuplicate.action).toBe('proceed');
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('launch door: blocked');
    expect(result.stderr).toContain('permission');
    expect(result.stderr).not.toContain('launch gate: blocked-duplicate');
    expect(result.stdout).not.toContain('[self-dev] run run-');
    expect(result.launchStamps).toEqual([]);
  }
});

test('ordinary CLI and queue-tick admit a green signal and allow permission under enforce', async () => {
  const permission = { ELANOUS_LAUNCH_DOOR_MODE: 'enforce', ELANOUS_LAUNCH_DOOR_PERMISSION: 'allow', ELANOUS_LAUNCH_DOOR_SIGNAL: 'green' };
  for (const queue of [false, true]) {
    const result = await say({ ...permission, ...(queue ? { ELANOUS_HARNESS_QUEUE_LAUNCH: `hq-${randomUUID()}`, ELANOUS_HARNESS_SEAT: 'OP' } : {}) });
    expect(result.stderr).not.toContain('launch door: blocked');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('No LLM provider available');
    expect(result.runLedgers.length).toBeGreaterThan(0);
  }
  const deniedEnvironments: Record<string, string>[] = [
    { ELANOUS_LAUNCH_DOOR_SIGNAL: 'red' },
    { ELANOUS_LAUNCH_DOOR_PERMISSION: 'deny' },
    { ELANOUS_HARNESS_QUEUE_LAUNCH: `hq-${randomUUID()}`, ELANOUS_HARNESS_SEAT: 'OP', ELANOUS_LAUNCH_DOOR_SIGNAL: 'red' },
    { ELANOUS_HARNESS_QUEUE_LAUNCH: `hq-${randomUUID()}`, ELANOUS_HARNESS_SEAT: 'OP', ELANOUS_LAUNCH_DOOR_PERMISSION: 'deny' },
  ];
  for (const extra of deniedEnvironments) {
    const result = await say({ ...permission, ...extra });
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('launch door: blocked');
    expect(result.runLedgers).toEqual([]);
  }
}, 300_000);

test('env adapter defaults safely and malformed values never grant permission', () => {
  expect(resolveLaunchDoorEnv({})).toEqual({ mode: 'shadow', modeSource: 'default', permission: 'deny', signal: 'unknown' });
  expect(resolveLaunchDoorEnv({ ELANOUS_LAUNCH_DOOR_MODE: '' })).toEqual({ mode: 'shadow', modeSource: 'default', permission: 'deny', signal: 'unknown' });
  expect(resolveLaunchDoorEnv({ ELANOUS_LAUNCH_DOOR_MODE: 'enforce', ELANOUS_LAUNCH_DOOR_PERMISSION: 'allow', ELANOUS_LAUNCH_DOOR_SIGNAL: 'green' }))
    .toEqual({ mode: 'enforce', modeSource: 'env', permission: 'allow', signal: 'green' });
  expect(resolveLaunchDoorEnv({ ELANOUS_LAUNCH_DOOR_MODE: 'typo', ELANOUS_LAUNCH_DOOR_PERMISSION: 'yes', ELANOUS_LAUNCH_DOOR_SIGNAL: 'maybe' }))
    .toEqual({ mode: 'shadow', modeSource: 'invalid', permission: 'deny', signal: 'unknown' });
});
