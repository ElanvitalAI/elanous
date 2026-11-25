// AUTOPILOT-GOAL-DRIVE — the pure judge and the ScheduleWakeup reader. Independent literals.
import { describe, expect, test } from 'bun:test';
import { decideGoalDrive, driveWindow, modelWakeDelayMs, type DriveInput } from './goal-drive.js';

const NOW = 1_795_590_000_000;
const base: DriveInput = { goalId: 'pin:a', failed: false, paused: false, backoff: false, personQueued: 0, needsHuman: false,
  waitingOn: 0, backgroundRunning: 0, sameReply: false, history: [], now: NOW };

describe('decideGoalDrive', () => {
  test('rail 30 · a hand whose open cell waits (turn ended waiting on a reply, or cell state waiting) pulls work next; a coordinator-free open cell does not', () => {
    const hand = { ...base, goalId: undefined } as DriveInput;
    expect(decideGoalDrive({ ...hand, waitingOn: 1, handPull: { cell: 'open', workNextAvailable: true } })).toEqual({ kind: 'continue', signal: 'hand-pull' });
    expect(decideGoalDrive({ ...hand, handPull: { cell: 'waiting', workNextAvailable: true } })).toEqual({ kind: 'continue', signal: 'hand-pull' });
    expect(decideGoalDrive({ ...hand, handPull: { cell: 'open', workNextAvailable: true } })).toEqual({ kind: 'stop', reason: 'no-goal' });
    expect(decideGoalDrive({ ...hand, waitingOn: 1, handPull: { cell: 'open', workNextAvailable: false } })).toEqual({ kind: 'stop', reason: 'no-goal' });
    expect(decideGoalDrive({ ...base, waitingOn: 1 })).toEqual({ kind: 'stop', reason: 'waiting-reply' });
  });
  test('signals: a model wake under 20 min · progress · open work; none → no-signal', () => {
    expect(decideGoalDrive({ ...base, modelWakeInMs: 10 * 60_000 })).toEqual({ kind: 'continue', signal: 'model-wake-short' });
    expect(decideGoalDrive({ ...base, modelWakeInMs: 25 * 60_000 })).toEqual({ kind: 'stop', reason: 'no-signal' });
    expect(decideGoalDrive({ ...base, stateChanged: true })).toEqual({ kind: 'continue', signal: 'progress' });
    expect(decideGoalDrive({ ...base, openWork: true })).toEqual({ kind: 'continue', signal: 'open-work' });
    expect(decideGoalDrive(base)).toEqual({ kind: 'stop', reason: 'no-signal' });
  });
  test('stops win over signals, in order', () => {
    const go = { ...base, stateChanged: true };
    expect(decideGoalDrive({ ...go, goalId: undefined } as DriveInput)).toEqual({ kind: 'stop', reason: 'no-goal' });
    expect(decideGoalDrive({ ...go, failed: true })).toEqual({ kind: 'stop', reason: 'failed' });
    expect(decideGoalDrive({ ...go, paused: true })).toEqual({ kind: 'stop', reason: 'paused' });
    expect(decideGoalDrive({ ...go, backoff: true })).toEqual({ kind: 'stop', reason: 'backoff' });
    expect(decideGoalDrive({ ...go, personQueued: 2 })).toEqual({ kind: 'stop', reason: 'person-input' });
    expect(decideGoalDrive({ ...go, needsHuman: true })).toEqual({ kind: 'stop', reason: 'needs-human' });
    expect(decideGoalDrive({ ...go, waitingOn: 1 })).toEqual({ kind: 'stop', reason: 'waiting-reply' });
    expect(decideGoalDrive({ ...go, backgroundRunning: 3 })).toEqual({ kind: 'stop', reason: 'agents-running' });
    expect(decideGoalDrive({ ...go, sameReply: true })).toEqual({ kind: 'stop', reason: 'no-progress' });
    expect(decideGoalDrive({ ...go, repeatToolCall: true })).toEqual({ kind: 'stop', reason: 'repeat-tool' });
  });
  test('goal-specific progress can continue after the cap, but unrelated state changes cannot', () => {
    const history = [NOW - 60_000, NOW - 120_000, NOW - 180_000];
    const progressed = { ...base, stateChanged: true, history, goalProgress: true };
    expect(decideGoalDrive(progressed)).toEqual({ kind: 'continue', signal: 'progress' });
    expect(decideGoalDrive({ ...base, stateChanged: true, history })).toEqual({ kind: 'stop', reason: 'cap' });
    expect(decideGoalDrive({ ...progressed, needsHuman: true })).toEqual({ kind: 'stop', reason: 'needs-human' });
    expect(decideGoalDrive({ ...progressed, sameReply: true })).toEqual({ kind: 'stop', reason: 'no-progress' });
    expect(decideGoalDrive({ ...progressed, paused: true })).toEqual({ kind: 'stop', reason: 'paused' });
    expect(decideGoalDrive({ ...progressed, repeatToolCall: true })).toEqual({ kind: 'stop', reason: 'repeat-tool' });
    expect(decideGoalDrive({ ...progressed, ledgerUnchanged: true })).toEqual({ kind: 'stop', reason: 'no-ledger-progress' });
    expect(decideGoalDrive({ ...progressed, blocked: true })).toEqual({ kind: 'stop', reason: 'blocked' });
    expect(decideGoalDrive({ ...progressed, goalId: undefined })).toEqual({ kind: 'stop', reason: 'no-goal' });
  });
  test('cap: 3 continuations inside 30 min stop the drive; older ones are forgotten', () => {
    const three = [NOW - 60_000, NOW - 120_000, NOW - 180_000];
    expect(decideGoalDrive({ ...base, stateChanged: true, history: three })).toEqual({ kind: 'stop', reason: 'cap' });
    expect(driveWindow([NOW - 31 * 60_000, NOW - 60_000], NOW)).toEqual([NOW - 60_000]);
    expect(decideGoalDrive({ ...base, stateChanged: true, history: [NOW - 31 * 60_000, NOW - 32 * 60_000, NOW - 33 * 60_000] }).kind).toBe('continue');
  });
});

test('modelWakeDelayMs reads the ScheduleWakeup tool rows (earliest), not prose', () => {
  expect(modelWakeDelayMs([
    { role: 'assistant', toolName: undefined },
    { role: 'tool', toolName: 'ScheduleWakeup', toolArgs: { delaySeconds: 900 } },
    { role: 'tool', toolName: 'ScheduleWakeup', toolArgs: { delaySeconds: '300' } },
    { role: 'tool', toolName: 'Bash', toolArgs: { delaySeconds: 1 } },
  ])).toBe(300_000);
  expect(modelWakeDelayMs([{ role: 'assistant', toolName: undefined }])).toBeUndefined();
});
