import { expect, test } from 'bun:test';
import { runTuiSelfRestartOnStaleBuild } from '../index.js';
import { setActiveSessionId } from '../session/index.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSeatStopDriver } from './seat-stop-port.js';

test('the old TUI retires its owner row before starting the replacement on the same PTY', async () => {
  const events: string[] = [];
  const result = await runTuiSelfRestartOnStaleBuild({
    migrateSessionId: 'mine', scriptPath: '/tmp/installed/bin/elanous.mjs', args: [],
    stale: () => ({ stale: true, reason: 'installed-moved' }),
    owned: () => ({ sessionId: 'mine', at: Date.now() }),
    liveActiveSessionId: () => 'mine', sessionExists: () => true,
    retireCurrentTui: () => { events.push('retire'); },
    spawnChild: async () => { events.push('spawn'); return 0; }, log: () => {},
  } as Parameters<typeof runTuiSelfRestartOnStaleBuild>[0]);
  expect(result.outcome).toBe('relaunch');
  expect(events).toEqual(['retire', 'spawn']);
});

test('migrate waits for a detached RunShell capsule and its following turn', async () => {
  let capsuleActive = true;
  let checkpoints = 0;
  const driver = createSeatStopDriver({
    control: {
      request: async (_mode, busy) => busy ? 'waiting' : 'accepted',
      turnEnded: async () => { checkpoints++; },
    },
    busy: () => false,
    capsulesActive: () => capsuleActive,
  } as Parameters<typeof createSeatStopDriver>[0]);
  expect(await driver.request({ requestId: 'm-1', mode: 'migrate' }, 'mine')).toBe('waiting');
  await driver.turnEnded();
  expect(checkpoints).toBe(0);
  capsuleActive = false;
  await driver.turnEnded();
  expect(checkpoints).toBe(1);
});

test('a different TUI writing the shared active marker cannot change the pinned migration session', async () => {
  const state = mkdtempSync(join(tmpdir(), 'cx13-migrate-active-'));
  const before = process.env.ELANOUS_STATE_DIR;
  process.env.ELANOUS_STATE_DIR = state;
  try {
    setActiveSessionId('other-seat-session');
    const result = await runTuiSelfRestartOnStaleBuild({
      migrateSessionId: 'mine', scriptPath: '/tmp/installed/bin/elanous.mjs', args: [],
      stale: () => ({ stale: true, reason: 'installed-moved' }),
      owned: () => ({ sessionId: 'mine', at: Date.now() }),
      sessionExists: () => true, retireCurrentTui: () => {},
      spawnChild: async () => 0, log: () => {},
    } as Parameters<typeof runTuiSelfRestartOnStaleBuild>[0]);
    expect(result.outcome).toBe('relaunch');
    expect(result.sessionId).toBe('mine');
  } finally {
    if (before === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = before;
    rmSync(state, { recursive: true, force: true });
  }
});
