import { describe, expect, test } from 'bun:test';
import { landCalibMetrics, landingCounts } from './land-calib-metrics';

const lines = (...rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n');
const now = Date.parse('2026-11-24T03:00:00Z');
const preflightFixtureSeconds = 90;
describe('landing calibration observations', () => {
  test('joins only matching completed runs, deduplicates and reports real medians', () => {
    const input = {
      dispatches: lines({ at: '2026-11-24T02:00:00Z', runId: 'a', host: 'node-b' }, { at: '2026-11-24T02:40:00Z', runId: 'b', host: 'node-b' }),
      memory: lines({ at: '2026-11-24T02:20:00Z', runId: 'a', host: 'node-b', eventType: 'batch-gate' }, { at: '2026-11-24T02:50:00Z', runId: 'b', host: 'node-b', eventType: 'batch-gate' }, { at: '2026-11-24T02:50:00Z', runId: 'b', host: 'node-b', eventType: 'batch-gate' }, { at: '2026-11-24T02:50:00Z', runId: 'c', host: 'node-b', eventType: 'batch-gate' }, { at: '2026-11-24T02:59:00Z', host: 'minim5', secs: preflightFixtureSeconds, eventType: 'enqueue-typecheck' }),
      refusals: lines({ at: '2026-11-24T02:45:00Z', kind: 'infra' }, { at: '2026-11-24T02:46:00Z', reason: 'unknown legacy' }, { at: '2026-11-24T01:59:00Z', kind: 'violation' }),
    };
    const actual = landCalibMetrics(input, now);
    expect(actual.gate).toEqual({ matchedCompleted: 2, medianMinutesByHost: { 'node-b': 15 } });
    expect(actual.preflight).toEqual({ medianSecondsByHost: { 'minim5': preflightFixtureSeconds } });
    expect(actual.refusals).toEqual({ infra: 1, violation: 0, unknown: 1 });
    expect(actual.landing).toBeNull();
    expect(actual.queue).toBeNull();
    expect(actual.judgeFirstPassRate).toBeNull();
    expect(actual.hosts).toBeNull();
    expect(actual.greenIncrease).toBeNull();
  });
  test('does not join a different host or future observations', () => {
    const input = { dispatches: lines({ at: '2026-11-24T02:30:00Z', runId: 'a', host: 'node-b' }), memory: lines({ at: '2026-11-24T02:50:00Z', runId: 'a', host: 'minim5', eventType: 'batch-gate' }, { at: '2026-11-24T03:01:00Z', runId: 'a', host: 'node-b', eventType: 'batch-gate' }), refusals: '' };
    expect(landCalibMetrics(input, now).gate).toEqual({ matchedCompleted: 0, medianMinutesByHost: {} });
  });
});

test('classifies only unique first-parent merge SHAs as train, leaving direct unmeasured', () => {
  const train = 'a'.repeat(40), normal = 'b'.repeat(40), old = 'c'.repeat(40);
  const log = [[train, Date.parse('2026-11-24T02:30:00Z') / 1000], [normal, Date.parse('2026-11-24T02:35:00Z') / 1000], [old, Date.parse('2026-11-24T01:30:00Z') / 1000]].map(row => row.join('\t')).join('\n');
  const ledger = `time\ttrain\tintegrationPr\tmergeSha\tcomponentPrs\tsideHost\tresult\n2026-11-24T02:31\ta\t123\t${train.slice(0, 12)}\t123\thost\tmerged\n2026-11-24T02:31\ta\t123\t${train.slice(0, 12)}\t123\thost\tmerged`;
  expect(landingCounts(log, ledger, now)).toEqual({ mainFirstParentCommits: 2, matchedTrainCommits: 1, otherOrUnknownCommits: 1, direct: null });
  expect(() => landingCounts('broken', ledger, now)).toThrow('invalid main log');
});
