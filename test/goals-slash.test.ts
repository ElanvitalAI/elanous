// /goal slash router tests — Plan-Mode UX P1.3.

import { afterEach, describe, expect, test } from 'bun:test';
import {
  _resetForTesting,
  startGoal,
  setStatus,
  getCurrentGoal,
} from '../src/goals/index.js';
import { executeGoalSlash } from '../src/goals/slash.js';

afterEach(() => {
  _resetForTesting();
});

describe('goals/slash — executeGoalSlash', () => {
  test('bare /goal shows "no active goal" when empty', () => {
    const r = executeGoalSlash({ subcommand: '', rest: [], defaultMode: 'judge' });
    expect(r.kind).toBe('message');
    expect(r.lines.join(' ')).toContain('No active goal');
  });

  test('/goal status shows live state', () => {
    startGoal({ objective: 'write tests' });
    const r = executeGoalSlash({ subcommand: 'status', rest: [], defaultMode: 'judge' });
    expect(r.kind).toBe('message');
    expect(r.lines.join(' ')).toContain('write tests');
  });

  test('/goal <objective> starts a goal', () => {
    const r = executeGoalSlash({ subcommand: 'fix', rest: ['the', 'auth', 'bug'], defaultMode: 'judge' });
    expect(r.kind).toBe('started');
    if (r.kind !== 'started') throw new Error('unreachable');
    expect(r.objective).toBe('fix the auth bug');
    expect(r.mode).toBe('judge');
    expect(getCurrentGoal()?.objective).toBe('fix the auth bug');
  });

  test('/goal start rejects when another goal active', () => {
    startGoal({ objective: 'first' });
    const r = executeGoalSlash({ subcommand: 'second', rest: ['goal'], defaultMode: 'judge' });
    expect(r.kind).toBe('error');
  });

  test('/goal pause transitions active → paused', () => {
    startGoal({ objective: 'x' });
    const r = executeGoalSlash({ subcommand: 'pause', rest: [], defaultMode: 'judge' });
    expect(r.kind).toBe('paused');
    expect(getCurrentGoal()?.status).toBe('paused');
  });

  test('/goal pause errors when no active goal', () => {
    const r = executeGoalSlash({ subcommand: 'pause', rest: [], defaultMode: 'judge' });
    expect(r.kind).toBe('error');
  });

  test('/goal resume transitions paused → active', () => {
    startGoal({ objective: 'x' });
    setStatus('paused');
    const r = executeGoalSlash({ subcommand: 'resume', rest: [], defaultMode: 'judge' });
    expect(r.kind).toBe('resumed');
    expect(getCurrentGoal()?.status).toBe('active');
  });

  test('/goal resume on already-active is no-op message', () => {
    startGoal({ objective: 'x' });
    const r = executeGoalSlash({ subcommand: 'resume', rest: [], defaultMode: 'judge' });
    expect(r.kind).toBe('message');
    expect(r.lines.join(' ')).toContain('already active');
  });

  test('/goal resume on complete goal errors', () => {
    startGoal({ objective: 'x' });
    setStatus('complete');
    const r = executeGoalSlash({ subcommand: 'resume', rest: [], defaultMode: 'judge' });
    expect(r.kind).toBe('error');
  });

  test('/goal clear drops current goal', () => {
    startGoal({ objective: 'x' });
    const r = executeGoalSlash({ subcommand: 'clear', rest: [], defaultMode: 'judge' });
    expect(r.kind).toBe('cleared');
    expect(getCurrentGoal()).toBeNull();
  });

  test('/goal clear with no goal is benign', () => {
    const r = executeGoalSlash({ subcommand: 'clear', rest: [], defaultMode: 'judge' });
    expect(r.kind).toBe('message');
    expect(r.lines.join(' ')).toContain('no goal to clear');
  });

  test('/goal budget shows current when no arg', () => {
    startGoal({ objective: 'x' });
    const r = executeGoalSlash({ subcommand: 'budget', rest: [], defaultMode: 'judge' });
    expect(r.kind).toBe('message');
    expect(r.lines.join(' ')).toContain('20 turns');
  });

  test('/goal budget <N> sets turn budget', () => {
    startGoal({ objective: 'x' });
    const r = executeGoalSlash({ subcommand: 'budget', rest: ['50'], defaultMode: 'judge' });
    expect(r.kind).toBe('message');
    expect(getCurrentGoal()?.budget.maxTurns).toBe(50);
  });

  test('/goal budget tokens=N sets token budget', () => {
    startGoal({ objective: 'x' });
    const r = executeGoalSlash({ subcommand: 'budget', rest: ['tokens=500000'], defaultMode: 'judge' });
    expect(r.kind).toBe('message');
    expect(getCurrentGoal()?.budget.tokenBudget).toBe(500_000);
  });

  test('/goal budget rejects invalid', () => {
    startGoal({ objective: 'x' });
    expect(executeGoalSlash({ subcommand: 'budget', rest: ['xyz'], defaultMode: 'judge' }).kind).toBe('error');
    expect(executeGoalSlash({ subcommand: 'budget', rest: ['-5'], defaultMode: 'judge' }).kind).toBe('error');
  });

  test('/goal mode spec shows P3-deferred message', () => {
    const r = executeGoalSlash({ subcommand: 'mode', rest: ['spec'], defaultMode: 'judge' });
    expect(r.kind).toBe('message');
    expect(r.lines.join(' ')).toContain('P3 follow-up');
  });

  test('/goal mode invalid errors', () => {
    expect(executeGoalSlash({ subcommand: 'mode', rest: ['yolo'], defaultMode: 'judge' }).kind).toBe('error');
  });

  test('/goal help lists subcommands', () => {
    const r = executeGoalSlash({ subcommand: 'help', rest: [], defaultMode: 'judge' });
    expect(r.kind).toBe('message');
    const text = r.lines.join('\n');
    expect(text).toContain('/goal <objective>');
    expect(text).toContain('/goal pause');
    expect(text).toContain('/goal resume');
    expect(text).toContain('Esc');
  });

  test('/goal with empty objective errors', () => {
    const r = executeGoalSlash({ subcommand: '   ', rest: [], defaultMode: 'judge' });
    // Whitespace-only treated as empty after trim — should error since neither status verb nor real objective
    expect(r.kind).toBe('error');
  });

  test('/goal config without snapshot returns hint', () => {
    const r = executeGoalSlash({ subcommand: 'config', rest: [], defaultMode: 'judge' });
    expect(r.kind).toBe('message');
    expect(r.lines.join(' ')).toContain('unavailable');
  });

  test('/goal config with snapshot prints all settings', () => {
    const r = executeGoalSlash({
      subcommand: 'config',
      rest: [],
      defaultMode: 'judge',
      config: {
        maxTurns: 25, wallClockMaxMs: 60_000, tokenBudget: 100_000,
        judgeModel: 'grok-4-fast-reasoning', judgeRetries: 2,
        resumeOnPlanModeExit: false,
        modeDefault: 'judge',
      },
    });
    expect(r.kind).toBe('message');
    const text = r.lines.join('\n');
    expect(text).toContain('maxTurns:');
    expect(text).toContain('25');
    expect(text).toContain('grok-4-fast-reasoning');
    expect(text).toContain('config.json');
  });

  test('/goal <obj> shows first-use tip when judgeModel empty', () => {
    const r = executeGoalSlash({
      subcommand: 'fix',
      rest: ['it'],
      defaultMode: 'judge',
      config: {
        maxTurns: 20, wallClockMaxMs: 30 * 60_000, tokenBudget: 200_000,
        judgeModel: '',  // default — empty
        judgeRetries: 1,
        resumeOnPlanModeExit: false,
        modeDefault: 'judge',
      },
    });
    expect(r.kind).toBe('started');
    expect(r.lines.join('\n')).toContain('Tip');
    expect(r.lines.join('\n')).toContain('judgeModel');
  });

  test('/goal <obj> omits tip when judgeModel set', () => {
    const r = executeGoalSlash({
      subcommand: 'fix',
      rest: ['it'],
      defaultMode: 'judge',
      config: {
        maxTurns: 20, wallClockMaxMs: 30 * 60_000, tokenBudget: 200_000,
        judgeModel: 'grok-4-fast-reasoning',  // already configured
        judgeRetries: 1,
        resumeOnPlanModeExit: false,
        modeDefault: 'judge',
      },
    });
    expect(r.kind).toBe('started');
    expect(r.lines.join('\n')).not.toContain('Tip');
  });
});
