import { beforeEach, describe, expect, test } from 'bun:test';
import type { RunLedgerEntry } from './run-ledger.js';
import { RUN_STOP_CLASSES, type RunStopClass, type RunStopRecord } from './run-stop.js';
import {
  AUTOHEAL_ACTION_BY_CLASS, AUTOHEAL_EVENT, autohealAlreadyAttempted, autohealFromStop, parseAutohealMode,
  resetAutohealProcessMemory, type AutohealAction, type AutohealActions,
} from './stop-autoheal.js';

beforeEach(() => { resetAutohealProcessMemory(); });

const record = (cls: RunStopClass, cause = `stopped: ${cls}`): RunStopRecord => ({
  class: cls, cause, evidenceRef: `run-ledger:r1:${cls}`, nextMove: 'next',
});

function memLedger(initial: RunLedgerEntry[] = []) {
  const entries = [...initial];
  return { entries, loadLedger: () => entries, writeLedger: (e: RunLedgerEntry) => { entries.push(e); } };
}

function spyActions(ok = true) {
  const calls: AutohealAction[] = [];
  const mk = (name: AutohealAction) => () => { calls.push(name); return { ok, detail: `${name} done` }; };
  const actions: AutohealActions = {
    'clean-workspace-regate': mk('clean-workspace-regate'),
    'rebase-regate': mk('rebase-regate'),
    'resume-from-salvage': mk('resume-from-salvage'),
    'derive-evidence-rejudge': mk('derive-evidence-rejudge'),
  };
  return { calls, actions };
}

const EXPECTED: Record<RunStopClass, AutohealAction> = {
  'env-unrelated': 'clean-workspace-regate',
  'main-sync': 'rebase-regate',
  'pod-died': 'resume-from-salvage',
  'evidence-uncovered': 'derive-evidence-rejudge',
  'review-repeat': 'needs-owner',
  'review-out-of-scope': 'needs-owner',
  fabric: 'needs-owner',
  'launch-failed': 'needs-owner',
  unclassified: 'needs-owner',
};

describe('STOP-AUTOHEAL class → action map', () => {
  test('covers every stop class', () => {
    for (const cls of RUN_STOP_CLASSES) expect(AUTOHEAL_ACTION_BY_CLASS[cls]).toBe(EXPECTED[cls]);
  });

  test('mode parse defaults to shadow; only exact "live" is live', () => {
    expect(parseAutohealMode(undefined)).toBe('shadow');
    expect(parseAutohealMode('LIVE')).toBe('shadow');
    expect(parseAutohealMode('live')).toBe('live');
  });
});

describe('STOP-AUTOHEAL shadow', () => {
  for (const cls of RUN_STOP_CLASSES) {
    test(`${cls}: records the would-be action and runs nothing`, async () => {
      const led = memLedger();
      const spy = spyActions();
      const res = await autohealFromStop({ runId: 'r1', record: record(cls) }, { mode: 'shadow', actions: spy.actions, ...led });
      expect(spy.calls).toEqual([]);
      expect(res.action).toBe(EXPECTED[cls]);
      expect(res.outcome).toBe(EXPECTED[cls] === 'needs-owner' ? 'needs-owner' : 'would-act');
      const lines = led.entries.filter((e) => e.event === AUTOHEAL_EVENT);
      expect(lines).toHaveLength(1);
      expect(lines[0]!.data).toMatchObject({ class: cls, action: EXPECTED[cls], mode: 'shadow', phase: 'result' });
    });
  }

  test('default mode is shadow', async () => {
    const led = memLedger();
    const spy = spyActions();
    const res = await autohealFromStop({ runId: 'r1', record: record('pod-died') }, { actions: spy.actions, ...led });
    expect(res).toMatchObject({ mode: 'shadow', outcome: 'would-act' });
    expect(spy.calls).toEqual([]);
  });
});

describe('STOP-AUTOHEAL live', () => {
  for (const cls of RUN_STOP_CLASSES) {
    test(`${cls}: dispatches ${EXPECTED[cls]}`, async () => {
      const led = memLedger();
      const spy = spyActions();
      const res = await autohealFromStop({ runId: 'r1', record: record(cls) }, { mode: 'live', actions: spy.actions, ...led });
      if (EXPECTED[cls] === 'needs-owner') {
        expect(spy.calls).toEqual([]);
        expect(res.outcome).toBe('needs-owner');
        expect(res.reason).toContain(`stopped: ${cls}`);
      } else {
        expect(spy.calls).toEqual([EXPECTED[cls]]);
        expect(res.outcome).toBe('healed');
        // attempt line written before the action, result line after
        expect(led.entries.map((e) => e.data.phase)).toEqual(['attempt', 'result']);
      }
    });
  }

  test('failed action → needs-owner with the failure', async () => {
    const led = memLedger();
    const spy = spyActions(false);
    const res = await autohealFromStop({ runId: 'r1', record: record('main-sync') }, { mode: 'live', actions: spy.actions, ...led });
    expect(res.outcome).toBe('needs-owner');
    expect(res.reason).toContain('rebase-regate failed');
  });

  test('throwing action → needs-owner, never throws', async () => {
    const led = memLedger();
    const res = await autohealFromStop({ runId: 'r1', record: record('env-unrelated') }, {
      mode: 'live', actions: { 'clean-workspace-regate': () => { throw new Error('boom'); } }, ...led,
    });
    expect(res).toMatchObject({ outcome: 'needs-owner', reason: expect.stringContaining('boom') });
  });

  test('unwired action → needs-owner(action-unwired), not «healed»', async () => {
    const led = memLedger();
    const res = await autohealFromStop({ runId: 'r1', record: record('evidence-uncovered') }, { mode: 'live', ...led });
    expect(res.outcome).toBe('needs-owner');
    expect(res.reason).toContain('action-unwired: derive-evidence-rejudge');
  });

  test('guard write failure → no action', async () => {
    const spy = spyActions();
    const res = await autohealFromStop({ runId: 'r1', record: record('pod-died') }, {
      mode: 'live', actions: spy.actions, loadLedger: () => null, writeLedger: () => { throw new Error('disk'); },
    });
    expect(spy.calls).toEqual([]);
    expect(res.outcome).toBe('needs-owner');
  });

  test('unreadable ledger guard → no action', async () => {
    const spy = spyActions();
    const res = await autohealFromStop({ runId: 'r1', record: record('pod-died') }, {
      mode: 'live', actions: spy.actions, loadLedger: () => { throw new Error('EACCES'); }, writeLedger: () => {},
    });
    expect(spy.calls).toEqual([]);
    expect(res).toMatchObject({ outcome: 'needs-owner', reason: expect.stringContaining('ledger-unreadable') });
  });
});

describe('STOP-AUTOHEAL one-attempt guard', () => {
  test('second dispatch for the same run·class·mode does nothing', async () => {
    const led = memLedger();
    const spy = spyActions();
    const first = await autohealFromStop({ runId: 'r1', record: record('env-unrelated') }, { mode: 'live', actions: spy.actions, ...led });
    const second = await autohealFromStop({ runId: 'r1', record: record('env-unrelated') }, { mode: 'live', actions: spy.actions, ...led });
    expect(first.outcome).toBe('healed');
    expect(second.outcome).toBe('already-attempted');
    expect(spy.calls).toEqual(['clean-workspace-regate']);
    expect(led.entries).toHaveLength(2);
  });

  test('a crashed attempt (attempt line only) still blocks a retry', async () => {
    const led = memLedger([{ runId: 'r1', event: AUTOHEAL_EVENT, data: { class: 'pod-died', mode: 'live', phase: 'attempt' } }]);
    const spy = spyActions();
    const res = await autohealFromStop({ runId: 'r1', record: record('pod-died') }, { mode: 'live', actions: spy.actions, ...led });
    expect(res.outcome).toBe('already-attempted');
    expect(spy.calls).toEqual([]);
  });

  test('a ledger reader that never sees the writes (null) still cannot re-run the action in this process', async () => {
    const spy = spyActions();
    const deps = { mode: 'live' as const, actions: spy.actions, loadLedger: () => null, writeLedger: () => {} };
    const first = await autohealFromStop({ runId: 'r-mem', record: record('main-sync') }, deps);
    const second = await autohealFromStop({ runId: 'r-mem', record: record('main-sync') }, deps);
    expect(first.outcome).toBe('healed');
    expect(second.outcome).toBe('already-attempted');
    expect(spy.calls).toEqual(['rebase-regate']);
  });

  test('guard is per class and per mode', () => {
    const ledger: RunLedgerEntry[] = [{ runId: 'r1', event: AUTOHEAL_EVENT, data: { class: 'main-sync', mode: 'shadow' } }];
    expect(autohealAlreadyAttempted(ledger, 'main-sync', 'shadow')).toBe(true);
    expect(autohealAlreadyAttempted(ledger, 'main-sync', 'live')).toBe(false);
    expect(autohealAlreadyAttempted(ledger, 'pod-died', 'shadow')).toBe(false);
    expect(autohealAlreadyAttempted(null, 'pod-died', 'shadow')).toBe(false);
  });
});
