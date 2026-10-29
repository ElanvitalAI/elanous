import { beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { defaultOverlaysDir, loadGraphOverlays, selectOverlays } from './graph-overlay-yaml.js';
import { GRAPH_SPECS } from './graph-templates.js';
import type { RunLedgerEntry } from './run-ledger.js';
import { classifyPodExitStop, recordRunStop, RUN_STOP_CLASSES, type RunStopClass, type RunStopRecord } from './run-stop.js';
import {
  AUTOHEAL_ACTION_BY_CLASS, AUTOHEAL_EVENT, autohealAlreadyAttempted, autohealFromStop, parseAutohealMode,
  repeatedStop,
  captureStopKnowhowCandidate,
  pickAutohealAction, resetAutohealProcessMemory, type AutohealAction, type AutohealActions, type AutohealLadder,
} from './stop-autoheal.js';

beforeEach(() => { resetAutohealProcessMemory(); });

describe('LOOP-STOP-KNOWHOW-CAPTURE', () => {
  test('parent stop creates one candidate and groups a second run with the same cell and reason', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stop-knowhow-'));
    try {
      const first = { ...record('scope-escape', 'scope-escape: outside path'), site: 'implement-aborted' };
      await autohealFromStop({ runId: 'run-first', goalId: 'CELL-A', record: first }, { mode: 'shadow', knowhowCandidateDir: dir, ...memLedger() });
      await autohealFromStop({ runId: 'run-second', goalId: 'CELL-A', record: first }, { mode: 'shadow', knowhowCandidateDir: dir, ...memLedger() });
      await autohealFromStop({ runId: 'run-second', goalId: 'CELL-A', record: first }, { mode: 'shadow', knowhowCandidateDir: dir, ...memLedger() });
      const files = readdirSync(dir).filter((name) => name.endsWith('.json'));
      expect(files).toHaveLength(1);
      const candidate = JSON.parse(readFileSync(join(dir, files[0]!), 'utf8'));
      expect(candidate).toMatchObject({ cell: 'CELL-A', reason: 'scope-escape', stage: 'implement-aborted', occurrences: 2, runIds: ['run-first', 'run-second'] });
      expect(candidate.causeLine).toBe('scope-escape: outside path');
      expect(candidate.nextLaunchChange).toContain('대상 경로');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('all four intermediate reasons are captured, normal or unrelated stops are not, unknown cell is explicit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stop-knowhow-'));
    try {
      const cases = [
        ['no-progress', { ...record('unclassified', 'unchanged'), childEvidence: { terminationReason: 'no-progress' } }],
        ['scope-escape', record('scope-escape')],
        ['wallclock-cap', { ...record('unclassified', 'elapsed'), childEvidence: { terminationReason: 'wallclock-cap' } }],
        ['pod-job-failed', { ...record('pod-died'), terminationReason: 'pod-job-failed' }],
      ] as const;
      for (const [reason, stop] of cases) {
        const result = captureStopKnowhowCandidate({ runId: `run-${reason}`, record: stop }, dir);
        expect(result?.candidate).toMatchObject({ cell: null, reason, stage: '미상', cellUnknownReason: expect.stringContaining('칸 미상') });
        expect(result?.candidate.stageUnknownReason).toContain('site');
      }
      expect(captureStopKnowhowCandidate({ runId: 'run-normal', record: record('main-sync') }, dir)).toBeUndefined();
      expect(captureStopKnowhowCandidate({ runId: 'run-pod-child', record: record('pod-died', 'pod-child-failed') }, dir)).toBeUndefined();
      expect(readdirSync(dir).filter((name) => name.endsWith('.json'))).toHaveLength(4);
      const fromChild = captureStopKnowhowCandidate({ runId: 'run-child', goalId: 'CELL-B', record: {
        ...record('unclassified', 'child stopped'),
        childEvidence: { terminationReason: 'wallclock-cap', detail: 'first failure line\nsecond line' },
      } }, dir);
      expect(fromChild?.candidate).toMatchObject({ cell: 'CELL-B', reason: 'wallclock-cap', causeLine: 'first failure line' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('a cause that merely mentions a stop reason does not create a candidate', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stop-knowhow-'));
    try {
      for (const reason of ['no-progress', 'scope-escape', 'wallclock-cap', 'pod-job-failed']) {
        expect(captureStopKnowhowCandidate({ runId: `run-${reason}`, record: record('unclassified', `not ${reason}: ordinary failure`) }, dir)).toBeUndefined();
      }
      expect(readdirSync(dir).filter((name) => name.endsWith('.json'))).toHaveLength(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('new stops update the last site and cause while older run IDs remain deduplicated', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stop-knowhow-'));
    try {
      for (let index = 0; index < 33; index++) {
        const result = captureStopKnowhowCandidate({ runId: `run-${index}`, goalId: 'CELL-A',
          record: { ...record('scope-escape', `cause ${index}`), site: `site-${index}` } }, dir,
        () => new Date(Date.UTC(2026, 9, 21, 0, index)));
        expect(result?.candidate.occurrences).toBe(index + 1);
      }
      const again = captureStopKnowhowCandidate({ runId: 'run-0', goalId: 'CELL-A',
        record: { ...record('scope-escape', 'old cause replayed'), site: 'old-site-replayed' } }, dir,
      () => new Date(Date.UTC(2026, 9, 21, 2, 0)));
      expect(again?.candidate).toMatchObject({ occurrences: 33, stage: 'site-32', causeLine: 'cause 32',
        lastAt: new Date(Date.UTC(2026, 9, 21, 0, 32)).toISOString() });
      expect(again?.candidate.runIds).toHaveLength(33);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

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
  'pod-vanished': 'needs-owner',
  'evidence-uncovered': 'derive-evidence-rejudge',
  'review-repeat': 'needs-owner',
  'review-out-of-scope': 'needs-owner',
  'review-budget-exhausted': 'needs-owner',
  'scope-escape': 'needs-owner',
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
      const res = await autohealFromStop({ runId: 'r1', record: record(cls) }, { mode: 'shadow', loadLadder: codeDefaultLadder, actions: spy.actions, ...led });
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
      const res = await autohealFromStop({ runId: 'r1', record: record(cls) }, { mode: 'live', loadLadder: codeDefaultLadder, actions: spy.actions, ...led });
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

describe('STOP-HEAL mock pod-failure scenario', () => {
  test('mock-pod-failure: injected stop records the safe salvage prescription and sim outcome', async () => {
    const runId = 'run-stop-heal-pod-failure-fixture';
    const led = memLedger();
    const actionSpy = spyActions();
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    const record: RunStopRecord = {
      class: classifyPodExitStop('pod-failure'),
      site: 'pod-exit',
      cause: 'pod-failure fixture: child container exited before a result line',
      evidenceRef: 'mock-fixture:pod-failure/exit',
      nextMove: 'inspect salvage evidence before any retry',
      terminationReason: 'pod-job-failed',
    };

    try {
      const stop = recordRunStop({ runId, ...record }, led.writeLedger);
      const result = await autohealFromStop({ runId, record }, { mode: 'shadow', actions: actionSpy.actions, ...led });

      expect(stop).toMatchObject({ runId, event: 'stop', data: { class: 'pod-died', site: 'pod-exit', terminationReason: 'pod-job-failed' } });
      expect(result).toMatchObject({ runId, class: 'pod-died', action: 'resume-from-salvage', mode: 'shadow', outcome: 'would-act' });
      expect(actionSpy.calls).toEqual([]);
      expect(led.entries.map((entry) => entry.event)).toEqual(['stop', AUTOHEAL_EVENT]);
      expect(led.entries[1]!.data).toMatchObject({
        class: 'pod-died', action: 'resume-from-salvage', mode: 'shadow', phase: 'result', outcome: 'would-act',
        evidenceRef: 'mock-fixture:pod-failure/exit', nextMove: 'inspect salvage evidence before any retry',
      });
      expect(log).toHaveBeenCalledWith('self-implement.autoheal', 'would-act', expect.objectContaining({
        runId, class: 'pod-died', action: 'resume-from-salvage', mode: 'shadow',
      }));
      console.log(`[sim-receipt] runId=${runId} event=stop class=pod-died source=pod-failure; event=${AUTOHEAL_EVENT} action=resume-from-salvage mode=shadow outcome=would-act; verificationCommand=bun test src/self-implement/stop-autoheal.test.ts -t mock-pod-failure`);
    } finally { log.mockRestore(); }
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

function codeDefaultLadder(): AutohealLadder {
  return { template: GRAPH_SPECS['self-implement'], overlays: [] };
}

describe('STOP-AUTOHEAL repeat-stop guard', () => {
  test('repeatedStop: same class in priorStops reaches the threshold; absent prior is false', () => {
    const prior: RunStopRecord[] = [record('env-unrelated'), record('env-unrelated'), record('main-sync')];
    expect(repeatedStop(prior, record('env-unrelated'))).toBe(true);
    expect(repeatedStop(prior, record('main-sync'))).toBe(false);
    expect(repeatedStop([record('main-sync')], record('main-sync'))).toBe(false);
    expect(repeatedStop([record('main-sync')], record('main-sync'), 1)).toBe(true);
    expect(repeatedStop(undefined, record('env-unrelated'))).toBe(false);
  });

  test('2 same-class priorStops → live mode makes 0 action-seam calls, outcome needs-owner, reason repeat-stop', async () => {
    const led = memLedger();
    const spy = spyActions();
    const priorStops: readonly RunStopRecord[] = [record('env-unrelated'), record('env-unrelated')];
    const res = await autohealFromStop(
      { runId: 'r1', record: record('env-unrelated') },
      { mode: 'live', actions: spy.actions, priorStops, ...led },
    );
    expect(spy.calls).toEqual([]);
    expect(res.outcome).toBe('needs-owner');
    expect(res.reason!.startsWith('repeat-stop:')).toBe(true);
    expect(res.reason).toContain('env-unrelated ×2');
    expect(res.reason).toContain(`feed back to goal: stopped: env-unrelated`);
    expect(led.entries).toEqual([]);
  });

  test('absent priorStops preserves existing behavior', async () => {
    const led = memLedger();
    const spy = spyActions();
    const res = await autohealFromStop({ runId: 'r1', record: record('env-unrelated') }, { mode: 'live', actions: spy.actions, ...led });
    expect(res.outcome).toBe('healed');
    expect(spy.calls).toEqual(['clean-workspace-regate']);
  });
});

describe('STOP-AUTOHEAL ladder declaration (graphs/overlays/stop-heal-ladder.yaml)', () => {
  test('code defaults cover every stop class when no exit overlay is declared', async () => {
    for (const cls of RUN_STOP_CLASSES) {
      const picked = pickAutohealAction(cls, codeDefaultLadder);
      expect({ cls, action: picked.action }).toEqual({ cls, action: AUTOHEAL_ACTION_BY_CLASS[cls] });
      expect(picked.source).toBe('code-default');
      const res = await autohealFromStop({ runId: `r-${cls}`, record: record(cls) }, { mode: 'shadow', loadLadder: codeDefaultLadder, ...memLedger() });
      expect(res.action).toBe(AUTOHEAL_ACTION_BY_CLASS[cls]);
    }
  });

  test('missing reauthor node hands off with an explicit reason instead of assuming a future exit', async () => {
    const ladder = ladderFromDisk();
    const withoutReauthor: AutohealLadder = {
      ...ladder,
      overlays: ladder.overlays.filter((overlay) => overlay.overlayId !== 'stop-heal-ladder-review-budget-exhausted'),
    };
    const picked = pickAutohealAction('review-budget-exhausted', () => withoutReauthor);
    expect(picked).toEqual({ action: 'needs-owner', source: 'code-default', fallbackReason: 'declared-node-unavailable: review-round-reauthor' });

    const led = memLedger();
    const res = await autohealFromStop({ runId: 'r-review-no-node', record: record('review-budget-exhausted') }, {
      mode: 'live', loadLadder: () => withoutReauthor, ...led,
    });
    expect(res).toMatchObject({
      action: 'needs-owner', source: 'code-default', outcome: 'needs-owner',
      reason: expect.stringContaining('declared-node-unavailable: review-round-reauthor'),
    });
    expect(led.entries.at(-1)?.data).toMatchObject({
      action: 'needs-owner', outcome: 'needs-owner', fallbackReason: 'declared-node-unavailable: review-round-reauthor',
    });
  });

  test('a declared reauthor overlay selects its exit without assuming the exit implementation exists', () => {
    const picked = pickAutohealAction('review-budget-exhausted', ladderFromDisk);
    expect(picked).toMatchObject({
      action: 'review-round-reauthor', source: 'graph', overlayId: 'stop-heal-ladder-review-budget-exhausted',
    });
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
      .toEqual(['heal', 'heal', 'heal', 'heal', 'heal']);
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
