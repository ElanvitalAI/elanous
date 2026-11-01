import { describe, expect, test } from 'bun:test';
import { buildRetroFeatureProposals, type RetroProposalSignal } from './retro-proposals.js';

const signal = (runId: string, at: string, source: RetroProposalSignal['source'] = 'incident', symptom = 'timeout') =>
  ({ runId, at, source, symptom }) satisfies RetroProposalSignal;

describe('buildRetroFeatureProposals', () => {
  test('period edges are inclusive and adjacent days are excluded', () => {
    const proposals = buildRetroFeatureProposals([
      signal('before', '2026-10-22T23:59:59.999Z'),
      signal('first', '2026-10-23T00:00:00.000Z'),
      signal('last', '2026-10-30T23:59:59.999Z', 'doctor-visit'),
      signal('after', '2026-10-31T00:00:00.000Z'),
    ], { from: '2026-10-23', to: '2026-10-30' });

    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.evidence.runIds).toEqual(['first', 'last']);
    expect(proposals[0]?.evidence).toMatchObject({ incidents: 1, doctorVisits: 1 });
  });

  test('requires distinct runs, not multiple observations from one run', () => {
    const proposals = buildRetroFeatureProposals([
      signal('same-run', '2026-10-23T01:00:00.000Z'),
      signal('same-run', '2026-10-23T02:00:00.000Z', 'doctor-visit'),
    ], { from: '2026-10-23', to: '2026-10-30', minimumRuns: 2 });

    expect(proposals).toEqual([]);
  });
});
