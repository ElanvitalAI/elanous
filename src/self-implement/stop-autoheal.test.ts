import { beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { debug } from '../debug/log.js';
import { defaultOverlaysDir, loadGraphOverlays, selectOverlays } from './graph-overlay-yaml.js';
import { GRAPH_SPECS } from './graph-templates.js';
import type { RunLedgerEntry } from './run-ledger.js';
import { RUN_STOP_CLASSES, type RunStopClass, type RunStopRecord } from './run-stop.js';
import {
  AUTOHEAL_ACTION_BY_CLASS, AUTOHEAL_EVENT, autohealAlreadyAttempted, autohealFromStop, parseAutohealMode,
  pickAutohealAction, resetAutohealProcessMemory, type AutohealAction, type AutohealActions, type AutohealLadder,
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
  'gate-failed': 'needs-owner',
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

function ladderFromDisk(): AutohealLadder {
  return {
    template: GRAPH_SPECS['self-implement'],
    overlays: loadGraphOverlays(defaultOverlaysDir()).overlays.filter((overlay) => overlay.overlayId.startsWith('stop-heal-ladder-')),
  };
}

describe('STOP-AUTOHEAL ladder declaration (graphs/overlays/stop-heal-ladder.yaml)', () => {
  test('every stop class picks the same action from the overlay as from the code table', async () => {
    for (const cls of RUN_STOP_CLASSES) {
      const picked = pickAutohealAction(cls);
      expect({ cls, action: picked.action }).toEqual({ cls, action: AUTOHEAL_ACTION_BY_CLASS[cls] });
      expect(picked.source).toBe(AUTOHEAL_ACTION_BY_CLASS[cls] === 'needs-owner' ? 'code-default' : 'graph');
      const res = await autohealFromStop({ runId: `r-${cls}`, record: record(cls) }, { mode: 'shadow', ...memLedger() });
      expect(res.action).toBe(AUTOHEAL_ACTION_BY_CLASS[cls]);
    }
  });

  test('missing ladder overlay falls back to code-default with source recorded', async () => {
    const empty: AutohealLadder = { template: ladderFromDisk().template, overlays: [] };
    const led = memLedger();
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const res = await autohealFromStop({ runId: 'r1', record: record('pod-died') }, { mode: 'shadow', loadLadder: () => empty, ...led });
      expect(res).toMatchObject({ action: 'resume-from-salvage', source: 'code-default', outcome: 'would-act' });
      expect(res.overlayId).toBeUndefined();
      expect(led.entries[0]!.data).toMatchObject({ source: 'code-default', action: 'resume-from-salvage' });
      expect(log).toHaveBeenCalledWith('self-implement.autoheal', 'action-source', {
        stopClass: 'pod-died', action: 'resume-from-salvage', source: 'code-default', overlayId: null,
      });
    } finally { log.mockRestore(); }
  });

  test('an unreadable ladder or a missing template falls back to the code table', () => {
    expect(pickAutohealAction('main-sync', () => { throw new Error('ENOENT'); })).toEqual({ action: 'rebase-regate', source: 'code-default' });
    expect(pickAutohealAction('main-sync', () => ({ template: undefined, overlays: ladderFromDisk().overlays })))
      .toEqual({ action: 'rebase-regate', source: 'code-default' });
  });

  test('an overlay whose node nothing reaches is rejected and the code table answers', () => {
    const ladder = ladderFromDisk();
    const broken = ladder.overlays.map((overlay) => overlay.overlayId === 'stop-heal-ladder-main-sync'
      ? { ...overlay, patch: overlay.patch.filter((op) => (op.value as { from?: string } | undefined)?.from !== 'heal') }
      : overlay);
    expect(pickAutohealAction('main-sync', () => ({ ...ladder, overlays: broken }))).toEqual({ action: 'rebase-regate', source: 'code-default' });
  });

  test('applied overlay id is recorded with the action', async () => {
    const led = memLedger();
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const res = await autohealFromStop({ runId: 'r1', record: record('evidence-uncovered') }, { mode: 'shadow', ...led });
      expect(res).toMatchObject({ action: 'derive-evidence-rejudge', source: 'graph', overlayId: 'stop-heal-ladder-evidence-uncovered' });
      expect(led.entries[0]!.data).toMatchObject({
        action: 'derive-evidence-rejudge', source: 'graph', overlayId: 'stop-heal-ladder-evidence-uncovered', phase: 'result',
      });
      expect(log).toHaveBeenCalledWith('self-implement.autoheal', 'action-source', {
        stopClass: 'evidence-uncovered', action: 'derive-evidence-rejudge', source: 'graph', overlayId: 'stop-heal-ladder-evidence-uncovered',
      });
    } finally { log.mockRestore(); }
  });

  test('the executor\'s launch and runtime overlay selection never picks the ladder, even with stop_class in state', () => {
    const graphId = GRAPH_SPECS['self-implement']!.graphId;
    const overlays = loadGraphOverlays(defaultOverlaysDir()).overlays;
    expect(overlays.filter((overlay) => overlay.overlayId.startsWith('stop-heal-ladder-')).map((overlay) => overlay.stage))
      .toEqual(['heal', 'heal', 'heal', 'heal']);
    for (const cls of RUN_STOP_CLASSES) {
      for (const stage of ['launch', 'runtime'] as const) {
        const { applied } = selectOverlays(overlays, { graphId, stage, state: { stop_class: cls } });
        expect({ cls, stage, ladder: applied.filter((overlay) => overlay.overlayId.startsWith('stop-heal-ladder-')).length })
          .toEqual({ cls, stage, ladder: 0 });
      }
    }
  });

  test('the declared node, not the table, decides — a redeclared ladder changes the action', () => {
    const ladder = ladderFromDisk();
    const redeclared = ladder.overlays.map((overlay) => overlay.overlayId === 'stop-heal-ladder-pod-died'
      ? { ...overlay, appliesWhen: 'stop_class == fabric' }
      : overlay);
    expect(pickAutohealAction('fabric', () => ({ ...ladder, overlays: redeclared }))).toEqual({
      action: 'resume-from-salvage', source: 'graph', overlayId: 'stop-heal-ladder-pod-died',
    });
  });
});
