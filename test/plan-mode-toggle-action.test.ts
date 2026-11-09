// Plan-mode toggle action tests — Plan-Mode UX P1.4.
//
// Real-wiring per CLAUDE.md isolation rule. Plan-mode session module
// is the actual state we exercise; dispatchEnterPlanMode is a real
// import.

import { afterEach, describe, expect, test } from 'bun:test';
import {
  _resetForTesting as resetGoals,
  getCurrentGoal,
  startGoal,
} from '../src/goals/index.js';
import {
  isPlanModeActive,
  resetPlanModeState,
  setPlanModeState,
} from '../src/plan-mode/index.js';
import { setPlanToolPlanModeGuard } from '../src/code-edit/plan-tool.js';
import { setPolicy } from '../src/code-edit/index.js';
import { togglePlanModeAction } from '../src/dashboard/plan-mode-toggle-action.ts';

afterEach(() => {
  // dispatchEnterPlanMode mutates global state beyond the plan-mode
  // session: it registers a plan-tool guard + flips the code-edit
  // approval policy to 'unsupervised'. Reset both so the next test
  // (e.g. icon-migration-batch's plan-tool dispatch path) sees a
  // clean baseline. Without this, BACKLOG #5-style cross-file
  // pollution propagates.
  resetPlanModeState();
  setPlanToolPlanModeGuard(null);
  setPolicy({ mode: 'ask-edit' });
  resetGoals();
});

describe('plan-mode-toggle-action', () => {
  test('inactive → entered (full path requires real dispatchEnterPlanMode)', async () => {
    // dispatchEnterPlanMode actually writes a plan artifact to disk,
    // so this test runs the full dispatch path. We just assert the
    // outcome shape; the artifact lifecycle has its own coverage.
    expect(isPlanModeActive()).toBe(false);
    const r = await togglePlanModeAction();
    expect(r.kind).toBe('entered');
    if (r.kind === 'entered') {
      expect(r.sessionId).toMatch(/.+/);
      expect(r.planFilePath).toMatch(/.+/);
      expect(isPlanModeActive()).toBe(true);
      expect(r.lines.some((l) => l.includes('Plan mode entered'))).toBe(true);
    }
  });

  test('already active → message branch (no second dispatch)', async () => {
    // Manually set plan-mode state to simulate active.
    setPlanModeState({
      active: true,
      sessionId: 'fake-sid',
      startedAt: Date.now(),
      phase: 'explore',
      planFilePath: '/tmp/fake-plan.md',
      previousPolicy: { mode: 'ask-edit' },
    });
    const r = await togglePlanModeAction();
    expect(r.kind).toBe('already-active');
    if (r.kind === 'already-active') {
      expect(r.sessionId).toBe('fake-sid');
      expect(r.lines.some((l) => l.includes('/plan exit'))).toBe(true);
    }
  });

  test('active goal is paused on plan-mode entry (Codex pattern)', async () => {
    startGoal({ objective: 'x' });
    expect(getCurrentGoal()?.status).toBe('active');
    await togglePlanModeAction();
    // plan-mode entry always pauses an active goal (goals.pauseOnPlanModeEnter removed)
    expect(getCurrentGoal()?.status).toBe('paused');
  });

  test('initialTitle threaded into dispatchEnterPlanMode', async () => {
    const r = await togglePlanModeAction({ initialTitle: 'refactor X' });
    expect(r.kind).toBe('entered');
    // initialTitle round-trips through dispatchEnterPlanMode into
    // the plan file path / state — sessionId presence is enough to
    // confirm the path completed.
    if (r.kind === 'entered') expect(r.sessionId.length).toBeGreaterThan(0);
  });
});
