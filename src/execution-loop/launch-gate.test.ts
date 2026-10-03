import { describe, expect, test } from 'bun:test';
import { activeRunsForGoal, launchRequestId, preLaunchGate } from './launch-gate.js';
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

  test('recent ledger activity alone is not a live process, while uncertain processes stay unknown', () => {
    expect(activeRunsForGoal(goalId, { queryRuns: () => observation([run('probable-running', { ptyRefs: [] })]), loadLedger })).toBe('unknown');
    expect(activeRunsForGoal(goalId, { queryRuns: () => observation([run('unknown')]), loadLedger: () => null })).toBe('unknown');
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
