import { describe, expect, it, spyOn } from 'bun:test';
import { debug } from '../debug/log.js';
import { runSelfImplement } from './orchestrator.js';
import { stableMustFixId } from './reflect-mustfix.js';
import { seams } from './test-seams.js';

const HEADER = '[라운드 요약 카드 — 이미 해 본 수와 결과]';

describe('orchestrator rework round card', () => {
  it('sends accumulated gate results only to rework rounds and observes each attached card', async () => {
    const features: string[] = [];
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const result = await runSelfImplement({
        runId: 'round-card-gate-fixture', feature: 'round card fixture', completion: 'worktree-only', memory: false,
        maxReworkRounds: 2,
        seams: seams({ features, gateResults: [false, false, true],
          diagnose: async () => 'BUDGET: EXTEND\nREASON: repair gate',
        }),
      });
      expect(result.ok).toBe(true);
      expect(features).toHaveLength(3);
      expect(features[0]).not.toContain(HEADER);
      expect(features[1]).toContain(HEADER);
      expect(features[1]).toContain('라운드 0 · gate');
      expect(features[1]).not.toContain('라운드 1 · gate');
      expect(features[2]).toContain(HEADER);
      expect(features[2]).toContain('라운드 0 · gate');
      expect(features[2]).toContain('라운드 1 · gate');
      expect(features[2]!.indexOf('[라운드 2/2')).toBeLessThan(features[2]!.indexOf(HEADER));
      const cards = log.mock.calls.filter(([category, event]) => category === 'self-dev.rework' && event === 'round-card')
        .map(([, , data]) => data);
      expect(cards).toMatchObject([
        { round: 1, entries: 1, omittedRounds: 0, chars: expect.any(Number) },
        { round: 2, entries: 2, omittedRounds: 0, chars: expect.any(Number) },
      ]);
    } finally {
      log.mockRestore();
    }
  });

  it('uses measured gate failures, changed files and a bounded single-line child summary', async () => {
    const features: string[] = [];
    let gateCalls = 0;
    const summary = `first\n  ${'x'.repeat(250)}`;
    const result = await runSelfImplement({
      runId: 'round-card-measured-fixture', feature: 'measured gate fixture', completion: 'worktree-only', memory: false,
      maxReworkRounds: 1,
      seams: seams({ features, changedFilesForGateRoute: () => ['src/sample.ts'],
        implement: async ({ feature }) => { features.push(feature); return { ok: true, summary }; },
        gate: async () => gateCalls++ === 0
          ? { passed: false, log: 'failed', baselineFailures: [
            { name: 'A', file: 'a.test.ts', attribution: 'introduced', baselinePresence: 'present' },
            { name: 'B', file: undefined, attribution: 'unknown', baselinePresence: 'unknown' },
          ] }
          : { passed: true, log: 'ok' },
      }),
    });
    expect(result.ok).toBe(true);
    expect(features[1]).toContain('A@a.test.ts (introduced), B@? (unknown)');
    expect(features[1]).toContain('손댄 파일: src/sample.ts');
    expect(features[1]).toContain(`해 본 수: ${summary.replace(/\s+/g, ' ').trim().slice(0, 200)} · 실패 id:`);
  });

  it('collects review must-fix stable ids before retrying the child', async () => {
    const features: string[] = [];
    let reviews = 0;
    const result = await runSelfImplement({
      runId: 'round-card-review-fixture', feature: 'review card fixture', completion: 'worktree-only', memory: false,
      maxReworkRounds: 1,
      seams: seams({ features, reviewDiff: async () => {
        reviews++;
        return reviews === 1
          ? { verdict: 'fail', mustFix: ['fix a'], shouldFix: [], summary: 'fix', reviewed: true, diffTruncated: false }
          : { verdict: 'pass', mustFix: [], shouldFix: [], summary: 'ok', reviewed: true, diffTruncated: false };
      } }),
    });
    expect(result.ok).toBe(true);
    expect(features[0]).not.toContain(HEADER);
    expect(features[1]).toContain('라운드 0 · review');
    expect(features[1]).toContain(stableMustFixId('fix a'));
  });
});
