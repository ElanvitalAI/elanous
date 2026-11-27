import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BOARD_LANES } from '../tui/widgets/scenes/burst-engine.js';
import { DEFAULT_BURST_CONFIG, planScale, pressures } from './op-pulse-burst.js';
import { DEFAULT_TARGETS, loadRhythm, pulseGaps, type PulseMeasure } from './op-pulse.js';
import { loadRhythmAndBurst } from './op-pulse-run.js';

// JUD-RELAX (CEO 11-26): JUD keeps the veto only. Today's board showed 35 cells waiting 112 min on the «Judge» lane —
// that wait must no longer press a burst lane, raise a pulse gap, or be drawn as a pipeline stage.
const RHYTHM = join(import.meta.dir, '../../graphs/triggers/op-pulse.rhythm.yaml');
const today = { targetGapRatio: 1, readyBacklog: 10, hands: 6, readyPerHand: 2, judgeWaitMin: 112, judgeWaitTargetMin: 30, judgeQueue: 35,
  gateWaitMin: null, gateWaitTargetMin: 10, reviewWaitMin: null, reviewWaitTargetMin: 20, landQueue: null, landQueueTarget: 6, hoursToDeadline: 2 };

describe('JUD-RELAX — the judge lane is veto only', () => {
  test('35 cells waiting 112 min put no pressure on the judge lane', () => {
    const judge = pressures(today).find(p => p.lane === 'judge')!;
    expect([judge.pressure, judge.why]).toEqual([null, 'veto only (JUD-RELAX) — no judge wait lane']);
  });
  test('the planner never scales judge hands — code defaults and the rhythm yaml both cap the lane at 0', () => {
    const { burst } = loadRhythmAndBurst(RHYTHM);
    for (const config of [DEFAULT_BURST_CONFIG, burst]) {
      expect(config.lanes.judge.max).toBe(0);
      // A burst start seeds levels from the preset — no preset may carry judge hands either.
      expect(config.presets.map(p => p.lanes.judge ?? 0)).toEqual(config.presets.map(() => 0));
      const plan = planScale({ levels: {}, lastChangeAt: {}, pressures: [{ lane: 'judge', pressure: 9, why: 'x' }], now: new Date('2026-11-26T12:00:00Z'),
        config, spentUsd: 0, budgetUsd: Infinity, cloudApprovedUsd: 0, hoursLeft: 4, forecastMisses: true });
      expect(plan.filter(d => d.lane === 'judge' && d.to > d.from)).toEqual([]);
    }
  });
  test('no phase has a judge-wait target or the judge-relief lever · a long judge wait is no pulse gap', () => {
    const rows = [...loadRhythm(RHYTHM).rows.values()];
    expect(rows.map(r => r.targets.judgeWaitMedianMin).filter(v => v !== null)).toEqual([]);
    expect(rows.flatMap(r => r.levers).filter(l => l === 'judge-relief')).toEqual([]);
    expect(DEFAULT_TARGETS.judgeWaitMedianMin).toBeNull();
    const m: PulseMeasure = { at: '2026-11-26T12:00:00Z', version: '0.3.38', landedPerH: 25, greenPerH: 12, judgeQueue: 35, judgeWaitMedianMin: 112, budget: [], unmeasured: [], spaces: [] };
    expect(pulseGaps(m, rows[0]!.targets).map(g => g.metric)).toEqual([]);
  });
  test('the board draws a «Veto» lane, not a «Judge» stage', () => {
    expect(BOARD_LANES.map(l => l.label)).toEqual(['Hands', 'Review', 'Pregate', 'Veto', 'Land']);
  });
});
