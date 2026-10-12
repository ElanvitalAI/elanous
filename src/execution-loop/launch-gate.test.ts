import { describe, expect, spyOn, test } from 'bun:test';
import { debug } from '../debug/log.js';
import { BUDGET_SNAPSHOT_ENV, activeRunsForGoal, encodeBudgetSnapshot, harnessLaunchBudgetDecision, launchRequestId, preLaunchGate, resolveLaunchBudget, type BudgetSnapshot } from './launch-gate.js';
import type { BudgetInputs } from '../self-implement/budget-gate.js';
import { ORIGINAL_ASK_MARKER } from '../self-implement/goal-author.js';
import type { QueriedRunningRunsResult, RunningRunAssessment } from '../self-implement/running-runs.js';
import type { RunLedgerEntry } from '../self-implement/run-ledger.js';

const goalId = 'goal-A';
const runId = 'run-11111111-1111-1111-1111-111111111111';
const directory = '/isolated/run-ledger';

function run(status: RunningRunAssessment['status'], overrides: Partial<RunningRunAssessment> = {}): RunningRunAssessment {
  return {
    runId, status, presence: 'ledger-and-pty-observed', reason: 'fixture', lifecycle: 'live',
    lastActivityTimestamp: null, ptyUpdatedAt: null, ledgerDirectories: [directory],
    ptyRefs: [{ instance: 'test', id: 'pty-1', kind: 'test' }], ...overrides,
  };
}

function observation(entries: RunningRunAssessment[], partial = false): QueriedRunningRunsResult {
  return {
    entries, completeness: partial ? 'partial' : 'complete', unreadable: [], count: 0,
    pty: { unreadable: [], observedRefCount: 0, withoutRunIdCount: 0, notCountedRefCount: 0 },
  } as unknown as QueriedRunningRunsResult;
}

function ledger(id: string): RunLedgerEntry[] {
  return [{ event: 'start', runId, goalId: id, data: {} }];
}

const loadLedger = (_id: string, _dir?: string) => ledger(goalId);

describe('activeRunsForGoal', () => {
  test('matches exact goal IDs only on process-observed running runs', () => {
    expect(activeRunsForGoal(goalId, { queryRuns: () => observation([run('running')]), loadLedger })).toEqual([runId]);
    expect(activeRunsForGoal('goal-B', { queryRuns: () => observation([run('running')]), loadLedger })).toEqual([]);
    expect(activeRunsForGoal(goalId, { queryRuns: () => observation([run('ended-unclosed')]), loadLedger })).toEqual([]);
  });

  test('old runs without a goal ID do not hide a different live goal, and skipped runs are counted', () => {
    const oldRuns = Array.from({ length: 3 }, (_, index) => run('ended-unclosed', {
      runId: `run-old-${index}`, ptyRefs: [],
    }));
    const noPty = run('running', { runId: 'run-no-pty', ptyRefs: [] });
    const ambiguous = run('unknown', { runId: 'run-ambiguous', ptyRefs: [] });
    const unreadable = run('unknown', { runId: 'run-unreadable', ptyRefs: [] });
    const other = run('running', { runId: 'run-other' });
    const entries = [...oldRuns, noPty, ambiguous, unreadable, other];
    const logs: Array<{ event: string; data: unknown }> = [];
    const log = spyOn(debug, 'log').mockImplementation((category, event, data) => {
      if (category === 'execution-loop.launch-gate') logs.push({ event, data });
    });
    try {
      const deps = {
        queryRuns: () => observation(entries),
        loadLedger: (id: string) => id === 'run-other' ? ledger('goal-B')
          : id === 'run-unreadable' ? null : [{ event: 'start' as const, runId: id, data: {} }],
      };
      expect(activeRunsForGoal(goalId, deps)).toEqual([]);
      expect(logs).toContainEqual({ event: 'active-runs-result', data: { goalId, result: [], skippedTerminal: 6 } });
      expect(logs.some(({ event }) => event === 'active-runs-unknown')).toBe(false);
      expect(preLaunchGate({ goalId }, deps)).toMatchObject({ action: 'proceed', sameGoalActiveRuns: [] });
    } finally {
      log.mockRestore();
    }
  });

  test('a live run with no goal ID stays unknown and preserves the reason', () => {
    const logs: Array<{ event: string; data: unknown }> = [];
    const log = spyOn(debug, 'log').mockImplementation((category, event, data) => {
      if (category === 'execution-loop.launch-gate') logs.push({ event, data });
    });
    try {
      const deps = {
        queryRuns: () => observation([run('ended-unclosed', { runId: 'run-old' }), run('running')]),
        loadLedger: (id: string) => [{ event: 'start' as const, runId: id, data: {} }],
      };
      expect(activeRunsForGoal(goalId, deps)).toBe('unknown');
      expect(logs).toContainEqual({
        event: 'active-runs-unknown',
        data: { goalId, reasons: [`${runId}: expected one goalId, found 0`], skippedTerminal: 1 },
      });
      expect(preLaunchGate({ goalId }, deps)).toMatchObject({ action: 'proceed', sameGoalActiveRuns: 'unknown' });
    } finally {
      log.mockRestore();
    }
  });

  test('unknown status with an observed PTY and unreadable goal ID remains unknown, not absent', () => {
    const logs: Array<{ event: string; data: unknown }> = [];
    const log = spyOn(debug, 'log').mockImplementation((category, event, data) => {
      if (category === 'execution-loop.launch-gate') logs.push({ event, data });
    });
    try {
      const queryRuns = () => observation([run('unknown')]);
      const deps = { queryRuns, loadLedger: () => [{ event: 'start' as const, runId, data: {} }] };
      expect(activeRunsForGoal(goalId, deps)).toBe('unknown');
      expect(logs).toContainEqual({
        event: 'active-runs-unknown',
        data: { goalId, reasons: [`${runId}: expected one goalId, found 0`], skippedTerminal: 0 },
      });
      expect(preLaunchGate({ goalId }, deps)).toMatchObject({ action: 'proceed', sameGoalActiveRuns: 'unknown' });
    } finally {
      log.mockRestore();
    }
  });

  test('multiple goal IDs in a live ledger are unknown, but multiple IDs without a PTY are skipped', () => {
    const multi = () => [ledger(goalId)[0]!, ledger('goal-B')[0]!];
    expect(activeRunsForGoal(goalId, {
      queryRuns: () => observation([run('running')]), loadLedger: multi,
    })).toBe('unknown');
    expect(activeRunsForGoal(goalId, {
      queryRuns: () => observation([run('running', { ptyRefs: [] })]), loadLedger: multi,
    })).toEqual([]);
  });

  test('a live same-goal run blocks despite old unidentified runs', () => {
    const deps = {
      queryRuns: () => observation([run('ended-unclosed', { runId: 'run-old' }), run('running')]),
      loadLedger: (id: string) => id === runId ? ledger(goalId) : [{ event: 'start' as const, runId: id, data: {} }],
    };
    expect(activeRunsForGoal(goalId, deps)).toEqual([runId]);
    expect(preLaunchGate({ goalId }, deps)).toMatchObject({ action: 'blocked-duplicate', sameGoalActiveRuns: [runId] });
  });

  test('a live authored goal matches the exact original harness say request, not authored prose or another request', () => {
    const ask = 'repeat this';
    const document = `# Generated goal\n${ORIGINAL_ASK_MARKER}\n\`\`\`text\n${ask}\n\`\`\`\n`;
    const queryRuns = () => observation([run('running')]);
    const readGoalDocument = (path: string) => {
      expect(path).toBe('/goals/active.md');
      return document;
    };
    const loadLedger = () => [{ event: 'start', runId, goalId: 'authored-id', data: { goalFile: '/goals/active.md' } }];
    const deps = { queryRuns, loadLedger, readGoalDocument };
    expect(activeRunsForGoal(launchRequestId(ask), deps)).toEqual([runId]);
    expect(activeRunsForGoal(launchRequestId('different request'), deps)).toEqual([]);
    expect(activeRunsForGoal(launchRequestId('Generated goal'), deps)).toEqual([]);
    expect(preLaunchGate({ goalId: launchRequestId(ask) }, deps).action).toBe('blocked-duplicate');
    expect(activeRunsForGoal(launchRequestId(ask), { ...deps, readGoalDocument: () => { throw new Error('unreadable'); } })).toBe('unknown');
    const noVerbatim = { ...deps, readGoalDocument: () => '# Generated goal\nrepeat this\n' };
    expect(activeRunsForGoal(launchRequestId(ask), noVerbatim)).toEqual([]);
    expect(activeRunsForGoal(launchRequestId(ask), { ...deps, queryRuns: () => observation([run('ended-unclosed')]) })).toEqual([]);
  });

  test('unknown process status with an observed PTY is not a confirmed duplicate', () => {
    const queryRuns = () => observation([run('unknown')]);
    expect(activeRunsForGoal(goalId, { queryRuns, loadLedger })).toBe('unknown');
    expect(preLaunchGate({ goalId }, { queryRuns, loadLedger })).toMatchObject({ action: 'proceed', sameGoalActiveRuns: 'unknown' });
  });

  test('ledger entry without a PTY is unknown, not proof that the run is absent', () => {
    const queryRuns = () => observation([run('unknown', { ptyRefs: [], presence: 'ledger-without-pty-observed' })]);
    expect(activeRunsForGoal(goalId, { queryRuns, loadLedger })).toBe('unknown');
    expect(activeRunsForGoal(goalId, { queryRuns: () => observation([run('running', { ptyRefs: [] })]), loadLedger })).toBe('unknown');
    expect(activeRunsForGoal('goal-B', { queryRuns, loadLedger })).toEqual([]);
  });

  test('recent ledger activity alone is not a live process, while live unreadable ledgers stay unknown', () => {
    expect(activeRunsForGoal(goalId, { queryRuns: () => observation([run('probable-running', { ptyRefs: [] })]), loadLedger })).toBe('unknown');
    expect(activeRunsForGoal(goalId, { queryRuns: () => observation([run('unknown')]), loadLedger: () => null })).toBe('unknown');
    expect(activeRunsForGoal(goalId, { queryRuns: () => observation([run('unknown', { ptyRefs: [] })]), loadLedger: () => null })).toEqual([]);
    expect(activeRunsForGoal(goalId, { queryRuns: () => observation([], true), loadLedger })).toBe('unknown');
    expect(activeRunsForGoal(goalId, { queryRuns: () => observation([run('running')]), loadLedger: () => { throw new Error('unreadable'); } })).toBe('unknown');
    expect(activeRunsForGoal(goalId, { queryRuns: () => { throw new Error('discovery failed'); } })).toBe('unknown');
  });
});

describe('preLaunchGate', () => {
  const budget = { action: 'proceed' as const, provider: 'grok', reasons: ['grok: 7% < 48'] };
  test('rejects confirmed duplicates, not unknown observation or dead runs', () => {
    expect(preLaunchGate({ goalId, budget }, { activeRuns: () => [runId] }).action).toBe('blocked-duplicate');
    expect(preLaunchGate({ goalId, budget }, { activeRuns: () => 'unknown' }).action).toBe('proceed');
    expect(preLaunchGate({ goalId, budget }, { activeRuns: () => [] }).action).toBe('proceed');
  });

  test('force overrides duplicate only; shortfall and wait-reset remain binding', () => {
    expect(preLaunchGate({ goalId, budget, forceLaunch: true }, { activeRuns: () => [runId] }).action).toBe('proceed');
    expect(preLaunchGate({ goalId, forceLaunch: true, budget: { action: 'stop', reasons: ['exhausted'] } }, { activeRuns: () => [runId] }).action).toBe('blocked-budget');
    expect(preLaunchGate({ goalId, forceLaunch: true, budget: { action: 'wait-reset', reasons: ['reset'] } }, { activeRuns: () => [runId] }).action).toBe('wait-reset');
  });
});

describe('Pod budget snapshot', () => {
  const now = Date.parse('2026-10-11T10:00:00Z');
  const snapshot = (overrides: Partial<BudgetSnapshot> = {}): BudgetSnapshot => ({
    provider: 'grok', remaining: 90, window: 'weekly', measuredAt: now - 60_000, host: 'host-1', decision: { action: 'proceed', provider: 'grok' }, ...overrides,
  });
  const podEnv = (value?: string): NodeJS.ProcessEnv => ({ ELANOUS_SUBSTRATE: 'pod', ...(value === undefined ? {} : { [BUDGET_SNAPSHOT_ENV]: value }) });
  const neverMeasure = async (): Promise<'unknown'> => { throw new Error('the Pod measured locally'); };
  /** A host-side launch-gate verdict, reached exactly as the host does it (chain ⊕ the user's caps). */
  const hostVerdict = (chain: string[], codexUsed: number, grokUsed: number) => harnessLaunchBudgetDecision({
    preference: { mode: 'auto', chain: chain.map((provider) => ({ provider })), budgetGate: { minHeadroomPercent: 0, onShortfall: 'stop' }, source: { mode: 'inferred', chain: 'fallbackChain' } },
    codexCandidates: [{ name: 'default', usedPercent: codexUsed }],
    grokUsedPercent: grokUsed,
    maxUsedPercent: { 'openai-codex': 95, grok: 80 },
  } as unknown as BudgetInputs).decision;

  test('a fresh parent snapshot decides the Pod gate', async () => {
    const logs: Array<{ event: string; data: any }> = [];
    const log = spyOn(debug, 'log').mockImplementation((category, event, data) => {
      if (category === 'execution-loop.launch-gate') logs.push({ event, data });
    });
    try {
      const ok = await resolveLaunchBudget({ env: podEnv(encodeBudgetSnapshot(snapshot())), now: () => now, measureLocal: neverMeasure });
      expect(ok).toMatchObject({ budgetSource: 'snapshot', snapshotAgeSec: 60, budget: { action: 'proceed', provider: 'grok' } });
      expect(preLaunchGate({ goalId, ...ok }, { activeRuns: () => [] }).action).toBe('proceed');
      const spent = await resolveLaunchBudget({ env: podEnv(encodeBudgetSnapshot(snapshot({ remaining: 10, decision: { action: 'stop' } }))), now: () => now, measureLocal: neverMeasure });
      expect(spent.budgetSource).toBe('snapshot');
      expect(preLaunchGate({ goalId, ...spent }, { activeRuns: () => [] }).action).toBe('blocked-budget');
      expect(logs.filter(({ event }) => event === 'decision').map(({ data }) => [data.budgetSource, data.snapshotAgeSec])).toEqual([['snapshot', 60], ['snapshot', 60]]);
    } finally {
      log.mockRestore();
    }
  });

  test('codex 95% with grok next in the chain: the host verdict is grok and the Pod does not block', async () => {
    const verdict = hostVerdict(['openai-codex', 'grok'], 96, 20);
    expect(verdict).toMatchObject({ action: 'next-provider', provider: 'grok' });
    const resolved = await resolveLaunchBudget({
      env: podEnv(encodeBudgetSnapshot(snapshot({ provider: 'openai-codex', remaining: 4, decision: { action: verdict.action, provider: verdict.provider! } }))),
      now: () => now, measureLocal: neverMeasure,
    });
    expect(resolved).toMatchObject({ budgetSource: 'snapshot', budget: { action: 'next-provider', provider: 'grok' } });
    expect(preLaunchGate({ goalId, ...resolved }, { activeRuns: () => [] }).action).toBe('proceed');
  });

  test('a host verdict that blocks blocks the Pod too', async () => {
    const verdict = hostVerdict(['openai-codex', 'grok'], 96, 85);
    expect(verdict.action).toBe('stop');
    const resolved = await resolveLaunchBudget({
      env: podEnv(encodeBudgetSnapshot(snapshot({ provider: 'openai-codex', remaining: 4, decision: { action: verdict.action } }))),
      now: () => now, measureLocal: neverMeasure,
    });
    expect(resolved.budgetSource).toBe('snapshot');
    expect(preLaunchGate({ goalId, ...resolved }, { activeRuns: () => [] }).action).toBe('blocked-budget');
    const waiting = await resolveLaunchBudget({ env: podEnv(encodeBudgetSnapshot(snapshot({ decision: { action: 'wait-reset' } }))), now: () => now, measureLocal: neverMeasure });
    expect(preLaunchGate({ goalId, ...waiting }, { activeRuns: () => [] }).action).toBe('wait-reset');
  });

  test('the Pod never re-judges usage itself — numbers past a code cap still follow the host verdict', async () => {
    const resolved = await resolveLaunchBudget({ env: podEnv(encodeBudgetSnapshot(snapshot({ remaining: 1, decision: { action: 'proceed', provider: 'grok' } }))), now: () => now, measureLocal: neverMeasure });
    expect(resolved.budget).toMatchObject({ action: 'proceed', provider: 'grok' });
  });

  test('a stale or missing snapshot, or one without a host verdict, marks unmeasured and proceeds', async () => {
    const stale = await resolveLaunchBudget({ env: podEnv(encodeBudgetSnapshot(snapshot({ measuredAt: now - 16 * 60_000, remaining: 0, decision: { action: 'stop' } }))), now: () => now, measureLocal: neverMeasure });
    expect(stale).toEqual({ budget: 'unknown', budgetSource: 'unmeasured', snapshotAgeSec: 960 });
    const missing = await resolveLaunchBudget({ env: podEnv(), now: () => now, measureLocal: neverMeasure });
    expect(missing).toEqual({ budget: 'unknown', budgetSource: 'unmeasured' });
    const garbage = await resolveLaunchBudget({ env: podEnv('{not json'), now: () => now, measureLocal: neverMeasure });
    expect(garbage.budgetSource).toBe('unmeasured');
    const noVerdict = await resolveLaunchBudget({ env: podEnv(encodeBudgetSnapshot(snapshot({ remaining: 0, decision: undefined }))), now: () => now, measureLocal: neverMeasure });
    expect(noVerdict).toEqual({ budget: 'unknown', budgetSource: 'unmeasured', snapshotAgeSec: 60 });
    const otherProvider = await resolveLaunchBudget({ env: podEnv(encodeBudgetSnapshot(snapshot({ requested: 'grok' }))), provider: 'openai-codex', now: () => now, measureLocal: neverMeasure });
    expect(otherProvider.budgetSource).toBe('unmeasured');
    const chainVerdictForExplicitAsk = await resolveLaunchBudget({ env: podEnv(encodeBudgetSnapshot(snapshot())), provider: 'grok', now: () => now, measureLocal: neverMeasure });
    expect(chainVerdictForExplicitAsk.budgetSource).toBe('unmeasured');
    for (const resolved of [stale, missing, noVerdict]) expect(preLaunchGate({ goalId, ...resolved }, { activeRuns: () => [] }).action).toBe('proceed');
  });

  test('a fresh host stop verdict survives small Pod clock skew, while a far-future snapshot is unmeasured', async () => {
    const fresh = encodeBudgetSnapshot(snapshot({ measuredAt: now + 2_000, decision: { action: 'stop' } }));
    const accepted = await resolveLaunchBudget({ env: podEnv(fresh), now: () => now, measureLocal: neverMeasure });
    expect(accepted).toMatchObject({ budgetSource: 'snapshot', snapshotAgeSec: -2, budget: { action: 'stop' } });
    expect(preLaunchGate({ goalId: 'clock-skew', ...accepted }, { activeRuns: () => [] }).action).toBe('blocked-budget');
    const future = encodeBudgetSnapshot(snapshot({ measuredAt: now + 31_000, decision: { action: 'stop' } }));
    expect(await resolveLaunchBudget({ env: podEnv(future), now: () => now, measureLocal: neverMeasure })).toEqual({ budget: 'unknown', budgetSource: 'unmeasured', snapshotAgeSec: -31 });
  });

  test('the Pod gate never re-measures locally when a snapshot exists, for grok, codex and zai alike', async () => {
    for (const provider of ['grok', 'openai-codex', 'zai']) {
      let measured = 0;
      const resolved = await resolveLaunchBudget({
        env: podEnv(encodeBudgetSnapshot(snapshot({ provider, requested: provider, decision: { action: 'proceed', provider } }))), provider, now: () => now,
        measureLocal: async () => { measured += 1; return 'unknown'; },
      });
      expect(resolved.budgetSource).toBe('snapshot');
      expect(measured).toBe(0);
    }
    const codex = await resolveLaunchBudget({ env: podEnv(encodeBudgetSnapshot(snapshot({ provider: 'codex', requested: 'codex', remaining: 3, decision: { action: 'stop' } }))), provider: 'codex-rotate', now: () => now, measureLocal: neverMeasure });
    expect(codex.budget).toMatchObject({ action: 'stop' });
  });

  test('outside a Pod the host measures as before and the snapshot env is ignored', async () => {
    let measured = 0;
    const decision = { action: 'proceed' as const, reasons: [] };
    const resolved = await resolveLaunchBudget({
      env: { [BUDGET_SNAPSHOT_ENV]: encodeBudgetSnapshot(snapshot()) },
      measureLocal: async () => { measured += 1; return decision; },
    });
    expect(resolved).toEqual({ budget: decision, budgetSource: 'local' });
    expect(measured).toBe(1);
  });

  test('the snapshot carries numbers and names only', () => {
    const encoded = encodeBudgetSnapshot({ ...snapshot({ requested: 'grok', decision: { action: 'proceed', provider: 'grok', reasons: ['account secret-reason'], token: 'secret-verdict' } as never }), token: 'secret-value' } as BudgetSnapshot);
    const parsed = JSON.parse(encoded);
    expect(Object.keys(parsed).sort()).toEqual(['decision', 'host', 'measuredAt', 'provider', 'remaining', 'requested', 'window']);
    expect(Object.keys(parsed.decision).sort()).toEqual(['action', 'provider']);
    expect(encoded).not.toContain('secret');
  });
});
