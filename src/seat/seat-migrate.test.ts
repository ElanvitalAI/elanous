import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exitTuiRun, runTuiSelfRestartOnStaleBuild } from '../index.js';
import { requestTuiSelfRestart } from '../capture/tui-self-report.js';

test('seat migrate restarts the owned session even when the running build is current', async () => {
  const spawned: string[][] = [];
  let exitCode: number | undefined;
  await exitTuiRun({
    takeRestartRequest: () => ({ reason: 'seat-stop:migrate:session-42' }),
    stale: () => ({ stale: false, reason: 'matches-installed' }),
    owned: () => ({ sessionId: 'session-42', at: 1 }),
    liveActiveSessionId: () => 'session-42', sessionExists: () => true,
    globalLatestSessionId: () => null, scriptPath: '/tmp/current/bin/elanous.mjs', args: ['--tui', 'next'],
    spawnChild: async (_command, argv) => { spawned.push([...argv]); return 0; },
    exit: (code): never => { exitCode = code; throw new Error('exit'); }, log: () => {},
  }).catch(() => {});
  expect(spawned).toEqual([['/tmp/current/bin/elanous.mjs', '--tui', 'next', '--resume', 'session-42']]);
  expect(exitCode).toBe(0);
});

test('seat migrate refuses when its requested session no longer belongs to this TUI', async () => {
  let spawned = false;
  const result = await runTuiSelfRestartOnStaleBuild({
    migrateSessionId: 'session-old', stale: () => ({ stale: false, reason: 'matches-installed' }),
    owned: () => ({ sessionId: 'session-new', at: 1 }), liveActiveSessionId: () => 'session-new',
    sessionExists: () => true, globalLatestSessionId: () => null,
    spawnChild: async () => { spawned = true; return 0; }, log: () => {},
  });
  expect(result).toEqual({ outcome: 'blocked', reason: 'migration-session-mismatch' });
  expect(spawned).toBe(false);
});

test('seat migrate selects the current install entry and refuses when it is missing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'seat-migrate-current-'));
  const current = join(root, 'current', 'node_modules', 'elanous', 'bin', 'elanous.mjs');
  const spawns: string[][] = [];
  const deps = { migrateSessionId: 'session-42', currentInstallRoot: root,
    stale: () => ({ stale: false, reason: 'matches-installed' }),
    owned: () => ({ sessionId: 'session-42', at: 1 }), liveActiveSessionId: () => 'session-42',
    sessionExists: () => true, globalLatestSessionId: () => null, args: [], log: () => {},
    spawnChild: async (_command: string, argv: readonly string[]) => { spawns.push([...argv]); return 0; } };
  try {
    expect(await runTuiSelfRestartOnStaleBuild(deps)).toEqual({ outcome: 'blocked', reason: 'migration-current-missing' });
    mkdirSync(join(root, 'current', 'node_modules', 'elanous', 'bin'), { recursive: true });
    writeFileSync(current, '');
    expect((await runTuiSelfRestartOnStaleBuild(deps)).outcome).toBe('relaunch');
    expect(spawns).toEqual([[current, '--resume', 'session-42']]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('seat migrate exits nonzero when the requested session cannot be resumed', async () => {
  let exitCode: number | undefined;
  await exitTuiRun({ takeRestartRequest: () => ({ reason: 'seat-stop:migrate:session-old' }),
    stale: () => ({ stale: false, reason: 'matches-installed' }),
    owned: () => ({ sessionId: 'session-new', at: 1 }), liveActiveSessionId: () => 'session-new',
    sessionExists: () => true, globalLatestSessionId: () => null, scriptPath: '/tmp/current/elanous.mjs',
    spawnChild: async () => { throw new Error('must not spawn'); },
    exit: (code): never => { exitCode = code; throw new Error('exit'); }, log: () => {},
  }).catch(() => {});
  expect(exitCode).toBe(1);
});

test('seat migrate retains the control request ID for the restart observation', async () => {
  const observed: unknown[] = [];
  requestTuiSelfRestart('seat-stop:migrate:session-42', 123, { requestId: 'request-42' });
  await exitTuiRun({ stale: () => ({ stale: false, reason: 'matches-installed' }),
    owned: () => ({ sessionId: 'session-42', at: 1 }), liveActiveSessionId: () => 'session-42',
    sessionExists: () => true, globalLatestSessionId: () => null, scriptPath: '/tmp/current/elanous.mjs',
    spawnChild: async () => 0, turnLifeLog: (event, data) => { observed.push([event, data]); },
    exit: (): never => { throw new Error('exit'); }, log: () => {},
  }).catch(() => {});
  expect(observed).toEqual([['turn-life:seat-control-relaunch', { eventId: 'request-42', sessionId: 'session-42', outcome: 'starting' }]]);
});
