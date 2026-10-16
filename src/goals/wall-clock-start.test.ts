// TUI-GOAL-LOOP-FRICTION(#35) — 벽시계 예산의 기준 = «이번 활성화 시작»(activeSince).
// 실측(10-14 21:47 OPT): «budget exhausted (wall-clock 487936263/1800000ms)» — 약 5분 턴에 4.9억 ms(≈135시간).
// 기준이 createdAt(며칠 전 만든 목표)이라 재개·재기동 직후에 바로 «소진»으로 멈췄다.
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import {
  _resetForTesting,
  _setGoalTransitionLedgerWriterForTesting,
  evaluateGoalBudget,
  getCurrentGoal,
  goalWallClockElapsedMs,
  goalWallClockStart,
  hydrateGoalFromSnapshot,
  recordTurn,
  setStatus,
  startGoal,
} from './registry.js';
import type { Goal } from './types.js';

const HOUR = 60 * 60_000;
const DAYS_5 = 5 * 24 * HOUR;
const originalStateDir = process.env.ELANOUS_STATE_DIR;
let stateDir = '';

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'elanous-goal-wallclock-'));
  process.env.ELANOUS_STATE_DIR = stateDir;
  _setGoalTransitionLedgerWriterForTesting(() => {});
});

afterEach(() => {
  _resetForTesting();
  if (originalStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
  else process.env.ELANOUS_STATE_DIR = originalStateDir;
  rmSync(stateDir, { recursive: true, force: true });
});

describe('goal wall-clock budget starts at this activation (TUI-GOAL-LOOP-FRICTION #35)', () => {
  test('resume after days paused measures from the resume, not from createdAt', () => {
    const now = spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      const started = startGoal({ objective: 'x', budget: { wallClockMaxMs: 30 * 60_000 } });
      if (!started.ok) throw new Error('start');
      expect(started.goal.activeSince).toBe(1_000);
      setStatus('paused', 'user-pause');
      now.mockReturnValue(1_000 + DAYS_5);
      setStatus('active', 'user-resume');
      now.mockReturnValue(1_000 + DAYS_5 + 5 * 60_000); // 이번 실행 5분
      recordTurn({ tokens: 1 });
      const goal = getCurrentGoal()!;
      expect(goal.usage.elapsedMs).toBe(5 * 60_000);
      const budget = evaluateGoalBudget(goal, Date.now());
      expect(budget.exceededAxes.find((a) => a.axis === 'wallClockMaxMs')).toBeUndefined();
      expect(budget.isOverBudget).toBe(false);
    } finally {
      now.mockRestore();
    }
  });

  test('반증 — a goal that really runs past its wall-clock limit in one activation is still exhausted', () => {
    const now = spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      startGoal({ objective: 'x', budget: { wallClockMaxMs: 30 * 60_000 } });
      now.mockReturnValue(1_000 + 31 * 60_000);
      recordTurn({ tokens: 1 });
      const budget = evaluateGoalBudget(getCurrentGoal()!, Date.now());
      expect(budget.exceededAxes).toContainEqual({ axis: 'wallClockMaxMs', used: 31 * 60_000, limit: 30 * 60_000 });
    } finally {
      now.mockRestore();
    }
  });

  test('a restart hydrating an active goal created days ago restarts the clock (no 4.9e8 ms)', () => {
    const now = spyOn(Date, 'now').mockReturnValue(1_000);
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const started = startGoal({ objective: 'x', budget: { wallClockMaxMs: 30 * 60_000 } });
      if (!started.ok) throw new Error('start');
      _resetForTesting(); // 프로세스 재기동 흉내(스냅숏은 그대로)
      _setGoalTransitionLedgerWriterForTesting(() => {});
      now.mockReturnValue(1_000 + 487_936_263);
      const hydrated = hydrateGoalFromSnapshot();
      expect(hydrated).toMatchObject({ id: started.goal.id, status: 'active', activeSince: 1_000 + 487_936_263 });
      expect(hydrated!.usage.elapsedMs).toBe(0);
      now.mockReturnValue(1_000 + 487_936_263 + 60_000);
      expect(evaluateGoalBudget(getCurrentGoal()!, Date.now()).isOverBudget).toBe(false);
      const hydratedLog = log.mock.calls.find(([c, e]) => c === 'goal' && e === 'snapshot.hydrated');
      expect(hydratedLog?.[2]).toMatchObject({ wallClockRestarted: true, staleElapsedMs: 487_936_263 });
    } finally {
      log.mockRestore();
      now.mockRestore();
    }
  });

  test('old snapshots without activeSince fall back to createdAt; reactivation records the restart', () => {
    const legacy = { createdAt: 10, activeSince: undefined } as unknown as Goal;
    expect(goalWallClockStart(legacy)).toBe(10);
    expect(goalWallClockElapsedMs(legacy, 5)).toBe(0);
    const now = spyOn(Date, 'now').mockReturnValue(1_000);
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      startGoal({ objective: 'x' });
      setStatus('budget-limited', 'budget-exhausted');
      now.mockReturnValue(1_000 + HOUR);
      setStatus('active', 'user-resume');
      const restart = log.mock.calls.find(([c, e]) => c === 'goal' && e === 'wall-clock-restart');
      expect(restart?.[2]).toMatchObject({ from: 'budget-limited', priorElapsedMs: HOUR });
      // active → active 는 새 활성화가 아니다(시계 유지).
      now.mockReturnValue(1_000 + 2 * HOUR);
      setStatus('active', 'noop');
      expect(getCurrentGoal()!.activeSince).toBe(1_000 + HOUR);
    } finally {
      log.mockRestore();
      now.mockRestore();
    }
  });
});
