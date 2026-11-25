// SIM — burst forecast · pressure planner (local first · front-to-back · anticipate) · budget/card gate · clean exit.
import { describe, expect, test } from 'bun:test';
import { burstCourse, DEFAULT_BURST_CONFIG, exitBurst, forecast, planScale, recordLaunch, startBurst, type BurstState, type LanePressure, type ScaleInput } from './op-pulse-burst.js';
import { burstEntry, demandSurge } from './op-pulse-urgency.js';

const NOW = new Date('2026-11-26T10:00:00Z');
const presets = DEFAULT_BURST_CONFIG.presets;
const cut = (hours: number, remaining: number) => [{ label: '0.3.37 cut', at: new Date(NOW.getTime() + hours * 3_600_000).toISOString(), source: 'release-cut' as const, remaining }];

describe('forecast → preset', () => {
  test('fast rate → no proposal', () => {
    const [row] = forecast(cut(6, 30), 10, NOW, presets);
    expect(row!.shortfall).toBe(0);
    expect(row!.preset).toBe(null);
  });
  test('slow rate near the deadline → the smallest preset that closes it', () => {
    // 6h left · rate 5/h → 30 done · 40 remaining: 2h ×1.5 = 35 (short) · 4h ×2 = 50 ≥ 40 → 4h.
    const [row] = forecast(cut(6, 40), 5, NOW, presets);
    expect(row!.shortfall).toBe(10);
    expect(row!.preset).toBe('4h');
    expect(row!.presetCloses).toBe(true);
    expect(row!.projectedFinish).toBe('2026-11-26T18:00:00.000Z');
  });
  test('slightly short → 2h', () => {
    const [row] = forecast(cut(6, 33), 5, NOW, presets);
    expect(row!.preset).toBe('2h');
  });
  test('no preset closes → the largest, flagged', () => {
    const [row] = forecast(cut(2, 100), 5, NOW, presets);
    expect(row!.preset).toBe('8h');
    expect(row!.presetCloses).toBe(false);
  });
});

describe('entry triggers', () => {
  const line = (urgency: 'urgent' | 'all-in') => ({ msgId: 501, crownDirective: 'c-9', urgency, at: NOW.toISOString() });
  test('CEO all-in → immediate 8h, even with a burst running', () => {
    const e = burstEntry({ ceoLines: [line('all-in')], demand: { surge: false, evidence: '' }, forecastPreset: null, forecastWhy: '', burstActive: true });
    expect(e).toMatchObject({ trigger: 'ceo-all-in', preset: '8h', start: 'now', allIn: true });
  });
  test('CEO urgent → 4h that OP starts at once', () => {
    expect(burstEntry({ ceoLines: [line('urgent')], demand: { surge: false, evidence: '' }, forecastPreset: null, forecastWhy: '', burstActive: false }))
      .toMatchObject({ trigger: 'ceo-urgent', preset: '4h', start: 'op-now' });
  });
  test('demand surge that capacity cannot absorb → proposal; absorbable surge → none', () => {
    const surge = demandSurge({ newP0PerH: 9, baselineP0PerH: 2, activeRequirements: 3, readyBacklogGrowthPerH: 2 });
    expect(surge.surge).toBe(true);
    expect(burstEntry({ ceoLines: [], demand: surge, forecastPreset: '2h', forecastWhy: 'short 3', burstActive: false })).toMatchObject({ trigger: 'demand-surge', preset: '2h', start: 'propose' });
    expect(burstEntry({ ceoLines: [], demand: surge, forecastPreset: null, forecastWhy: '', burstActive: false })).toBe(null);
  });
  test('deadline only → proposal', () => {
    expect(burstEntry({ ceoLines: [], demand: { surge: false, evidence: '' }, forecastPreset: '4h', forecastWhy: 'x', burstActive: false })?.trigger).toBe('deadline');
  });
});

const P = (map: Partial<Record<string, number | null>>): LanePressure[] => Object.entries(map).map(([lane, pressure]) => ({ lane: lane as LanePressure['lane'], pressure: pressure ?? null, why: `${lane}` }));
const base = (over: Partial<ScaleInput>): ScaleInput => ({ levels: {}, lastChangeAt: {}, pressures: [], forecastMisses: true, now: NOW, config: DEFAULT_BURST_CONFIG,
  spentUsd: 0, budgetUsd: 100, cloudApprovedUsd: 0, hoursLeft: 4, ...over });
const ups = (d: ReturnType<typeof planScale>) => d.filter(x => !x.blocked && x.to > x.from).map(x => `${x.lane}:${x.from}->${x.to}`);

describe('planner rules', () => {
  test('(a) all-in with local headroom → local tabs to headroom, no VM', () => {
    const d = planScale(base({ allIn: true, pressures: P({ hands: 3 }), hosts: [{ host: 'mshq', kind: 'local', used: 1, cap: 4 }, { host: 'node-b', kind: 'lan', used: 0, cap: 5 }] }));
    expect(ups(d)).toEqual(['hands:0->3', 'ta:0->6', 'remote:0->5']);
    expect(d.find(x => x.lane === 'vm')).toBe(undefined);
  });
  test('(a2) local and LAN full → VM needs the cloud budget, else a CEO card', () => {
    const full = [{ host: 'mshq', kind: 'local' as const, used: 4, cap: 4 }, { host: 'node-b', kind: 'lan' as const, used: 5, cap: 5 }];
    const levels = { ta: 6 };
    const card = planScale(base({ pressures: P({ hands: 3 }), hosts: full, levels }));
    expect(card.find(x => x.lane === 'vm')?.blocked).toBe('ceo-card');
    const paid = planScale(base({ pressures: P({ hands: 3 }), hosts: full, levels, config: { ...DEFAULT_BURST_CONFIG, cloudBudgetUsd: 50 } }));
    expect(ups(paid)).toEqual(['vm:0->1']);
    const makes = planScale(base({ pressures: P({ hands: 3 }), hosts: full, levels, forecastMisses: false, config: { ...DEFAULT_BURST_CONFIG, cloudBudgetUsd: 50 } }));
    expect(ups(makes)).toEqual([]);
  });
  test('(b) bottleneck at review → widen review, not hands', () => {
    const d = planScale(base({ pressures: P({ hands: 2, review: 2.4, pregate: 0.9 }) }));
    expect(ups(d)).toEqual(['review:0->1']);
    expect(d.find(x => x.lane === 'hands')?.blocked).toBe('downstream');
  });
  test('(c) rising demand → step starts a lead time ahead', () => {
    // pressure 1.3 < up_at 1.5 now, slope 0.15/min × lead 2 min → 1.6: step now.
    const d = planScale(base({ pressures: P({ hands: 1.3 }), slopePerMin: { hands: 0.15 } }));
    expect(ups(d)).toEqual(['hands:0->2']);
    expect(d[0]!.why).toBe('step now: pressure 1.3 → 1.6 in 2 min (lead time) — the queue will exceed its target before the step lands');
    expect(ups(planScale(base({ pressures: P({ hands: 1.3 }) })))).toEqual([]);
  });
  test('stepwise up per cooldown, down when pressure falls (hysteresis band holds)', () => {
    const t0 = planScale(base({ pressures: P({ hands: 2 }) }));
    expect(ups(t0)).toEqual(['hands:0->2']);
    const cooling = planScale(base({ levels: { hands: 2 }, lastChangeAt: { hands: '2026-11-26T09:55:00Z' }, pressures: P({ hands: 2 }) }));
    expect(cooling.find(x => x.lane === 'hands')?.blocked).toBe('cooldown');
    const t1 = planScale(base({ levels: { hands: 2 }, lastChangeAt: { hands: '2026-11-26T09:40:00Z' }, pressures: P({ hands: 2 }) }));
    expect(ups(t1)).toEqual(['hands:2->4']);
    const band = planScale(base({ levels: { hands: 4 }, pressures: P({ hands: 1.0 }) }));
    expect(band).toEqual([]);
    const down = planScale(base({ levels: { hands: 4 }, pressures: P({ hands: 0.5 }) }));
    expect(down.map(x => `${x.lane}:${x.from}->${x.to}`)).toEqual(['hands:4->2']);
  });
  test('budget ceiling blocks every up step', () => {
    const d = planScale(base({ spentUsd: 100, budgetUsd: 100, pressures: P({ hands: 3 }) }));
    expect(d.map(x => x.blocked)).toEqual(['budget']);
  });
});

describe('burst lifecycle', () => {
  const preset = presets.find(p => p.name === '4h')!;
  const start = () => startBurst({ goal: 'land', until: '2026-11-26T14:00:00Z', scope: ['TC'], by: 'OP', now: NOW, preset, trigger: 'ceo-urgent', ceoLine: { msgId: 501, crownDirective: 'c-9' }, baseline: { landed: 100, green: 40 } }, null);
  test('start → N launches → exit closes all by exact id and writes the receipt', async () => {
    let s: BurstState = start();
    for (const id of ['w1:p1', 'w1:p2', 'w1:p3']) s = recordLaunch(s, { lane: 'hands', id }, NOW, 2);
    s = recordLaunch(s, { lane: 'ta', id: 'run-7' }, NOW, 3);
    const closed: string[] = [];
    const { state, receipt } = await exitBurst(s, { now: new Date('2026-11-26T12:00:00Z'), reason: 'goal reached', closer: async l => { closed.push(l.id); }, landedNow: 130, greenNow: 52 });
    expect(closed).toEqual(['w1:p1', 'w1:p2', 'w1:p3', 'run-7']);
    expect(state.status).toBe('exited');
    expect(state.levels).toEqual({});
    expect(receipt).toMatchObject({ launched: 4, closed: 4, closeFailed: [], landed: 30, green: 12, costUsd: 9, minutes: 120, trigger: 'ceo-urgent', ceoLine: { msgId: 501, crownDirective: 'c-9' } });
    expect(() => recordLaunch(state, { lane: 'hands', id: 'w1:p9' }, NOW)).toThrow('no new launches');
  });
  test('a close that fails stays on the receipt', async () => {
    const s = recordLaunch(start(), { lane: 'vm', id: 'gcp1' }, NOW, 0);
    const { receipt } = await exitBurst(s, { now: NOW, reason: 'until', closer: async () => { throw new Error('no stop command'); }, landedNow: null, greenNow: null });
    expect(receipt.closeFailed).toEqual([{ lane: 'vm', id: 'gcp1', error: 'no stop command' }]);
  });
  test('budget ceiling stops launches', () => {
    const s = startBurst({ goal: 'land', until: '2026-11-26T12:00:00Z', scope: ['TC'], by: 'OP', now: NOW, budgetUsd: 5 }, null);
    const one = recordLaunch(s, { lane: 'hands', id: 'p1' }, NOW, 4);
    expect(() => recordLaunch(one, { lane: 'hands', id: 'p2' }, NOW, 2)).toThrow('budget ceiling');
  });
  test('a second start while active is refused', () => {
    expect(() => startBurst({ goal: 'land', until: '2026-11-26T12:00:00Z', scope: [], by: 'OP', now: NOW, budgetUsd: 1 }, start())).toThrow('already active');
  });
  test('re-forecast: caught up → exit early; short with time left → continue; bigger need → extend', () => {
    const s = start();
    const [caught] = forecast(cut(4, 20), 10, NOW, presets);
    expect(burstCourse(s, caught!, NOW, presets).action).toBe('exit-early');
    const [need8] = forecast(cut(9, 80), 5, NOW, presets);
    expect(burstCourse(s, need8!, NOW, presets).action).toBe('extend');
    expect(burstCourse(s, null, new Date('2026-11-26T14:00:00Z'), presets).action).toBe('exit-until');
  });
});
