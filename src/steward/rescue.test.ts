import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectOutcomes, launch, planLaunches, readLaunchLedger } from './launch.js';
import { RESCUE_ALLOWED, isRescueAllowedAction, launchModeOf, parseStewardMode, rescueAllows, runStewardModeCli, type StewardMode } from './rescue.js';
import type { ScheduledDecision, TriageIssue } from './triage.js';

const issues: TriageIssue[] = [{ identifier: 'ELA-1', ref: 'ref-1', title: 'Build 1', body: 'Body 1\n출처: telegram' }];
const rows: ScheduledDecision[] = [{ issue: 'ELA-1', rung: 4, dependsOn: [], priority: 0, why: 'build', disposition: 'now' }];

test('shared rescue policy permits exactly four internal action categories and refuses external or unknown actions', () => {
  expect(RESCUE_ALLOWED).toEqual(['launch', 'harvest', 'alert', 'decision-card']);
  for (const action of ['launch', 'harvest', 'alert', 'decision-card'] as const) {
    expect(isRescueAllowedAction(action)).toBe(true);
    expect(rescueAllows('rescue', action)).toBe(true);
  }
  for (const action of ['publish', 'release-run', 'external-post', 'delete', 'config-change', 'git-force'] as const) {
    expect(isRescueAllowedAction(action)).toBe(false);
    expect(rescueAllows('rescue', action)).toBe(false);
  }
  for (const action of ['unknown', '', 'Launch']) expect(isRescueAllowedAction(action)).toBe(false);
  // Outside rescue the gate never interferes — the mode's own rules decide.
  expect(rescueAllows('shadow', 'publish')).toBe(true);
  expect(rescueAllows('live', 'external-post')).toBe(true);
});

test('rescue launches like live; shadow takes no action', () => {
  expect(launchModeOf('rescue')).toBe('live');
  expect(launchModeOf('shadow')).toBe('shadow');
  const dir = mkdtempSync(join(tmpdir(), 'steward-rescue-'));
  try {
    const shadowLedger = readLaunchLedger(dir);
    const shadowItem = planLaunches(rows, issues, shadowLedger, { mode: 'shadow' }).launches[0]!;
    const shadow = launch(shadowItem, { root: dir, ledger: shadowLedger, settings: { mode: 'shadow' },
      command: () => { throw new Error('shadow ran budget'); }, spawn: () => { throw new Error('shadow spawned'); } });
    expect(shadow.status).toBe('shadow');
    expect(collectOutcomes(shadowLedger, { root: dir, ledger: shadowLedger, settings: { mode: 'shadow' } })).toEqual([]);

    const liveDir = mkdtempSync(join(tmpdir(), 'steward-rescue-live-'));
    try {
      const ledger = readLaunchLedger(liveDir);
      const settings = { mode: 'rescue' as const };
      const item = planLaunches(rows, issues, ledger, settings).launches[0]!;
      let spawned = 0;
      let budgetSeat: string | undefined;
      let spawnSeat: string | undefined;
      const entry = launch(item, { root: liveDir, ledger, settings, launchSeat: () => liveDir,
        command: (_args, seat) => { budgetSeat = seat; return { exitCode: 0, stdout: '{"outcome":"proceed","reasons":[]}' }; },
        gate: (_goal, budget) => ({ action: 'proceed', sameGoalActiveRuns: [], budget, reason: 'ok' }),
        spawn: (_args, _log, seat) => { spawned++; spawnSeat = seat; return { pid: 99999999 }; } });
      expect([spawned, entry.status, budgetSeat, spawnSeat]).toEqual([1, 'launched', liveDir, liveDir]);
    } finally { rmSync(liveDir, { recursive: true, force: true }); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('steward mode CLI persists the mode and rejects unknown values', async () => {
  let stored = 'shadow' as StewardMode;
  const store = { read: () => stored, write: (mode: StewardMode) => { stored = mode; } };
  const logs: string[] = [];
  const log = console.log; const err = console.error;
  console.log = (line: string) => { logs.push(line); }; console.error = () => {};
  try {
    expect(await runStewardModeCli('rescue', { json: true }, store)).toBe(0);
    expect(stored).toBe('rescue');
    expect(JSON.parse(logs.at(-1)!)).toEqual({ before: 'shadow', mode: 'rescue' });
    expect(await runStewardModeCli(undefined, {}, store)).toBe(0);
    expect(logs.at(-1)).toBe('rescue');
    expect(await runStewardModeCli('chaos', {}, store)).toBe(2);
    expect(stored).toBe('rescue');
    expect(await runStewardModeCli('shadow', {}, store)).toBe(0);
    expect(stored).toBe('shadow');
  } finally { console.log = log; console.error = err; }
  expect(parseStewardMode('rescue')).toBe('rescue');
  expect(parseStewardMode('Rescue')).toBeNull();
});

test('config file round-trips loops.steward.mode = rescue', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'steward-rescue-cfg-'));
  try {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify({ loops: { steward: { mode: 'rescue' } } }));
    const { buildUserConfig } = await import('../user-config.js');
    expect(buildUserConfig(path).loops?.steward?.mode).toBe('rescue');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
