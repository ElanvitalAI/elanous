// DEMO-BURST-BOARD-LIVE — framed board at 200×80 (primary) · 160×50 · 140×50 · 200×60, replay story over seeds 1..3
// (real planner), live snapshot with every source missing, flat memory over a 10-minute run, no full-screen clears.
// Expected strings are literals (rule 11), not built from the renderer.
import { describe, expect, test } from 'bun:test';
import { DEFAULT_BURST_CONFIG, planScale, pressures } from '../../../loops/op-pulse-burst.js';
import { besides, fitRow, gaugeSegs, panel, rowText, sparkSegs } from '../panel.js';
import { plainBoard, renderBurstPanels } from './burst-board-panels.js';
import { planBurst } from './burst-engine.js';
import { liveSnapshot, type LiveReadings } from './burst-live.js';
import { burstDemoRun, burstFixture, DEMO_TICKS, playBurstReplay, renderForTerminal } from './burst-replay.js';

describe('panel kit', () => {
  test('framed titled box with right label', () => {
    expect(panel({ title: 'Hosts', right: '2 at cap', width: 24, height: 3 }, [[['mshq']]]).map(rowText)).toEqual([
      '┌─ Hosts ──── 2 at cap ┐',
      '│mshq                  │',
      '└──────────────────────┘',
    ]);
  });
  test('gauge with threshold mark · sparkline · fit · besides', () => {
    expect(gaugeSegs(0.5, 10, 'g', 0.8).map(([t]) => t).join('')).toBe('█████░░░┃░');
    expect(gaugeSegs(null, 4, 'g').map(([t]) => t).join('')).toBe('░░░░');
    expect(sparkSegs([0, 10, 20], 20).map(([t]) => t).join('')).toBe('▁▅█');
    expect(sparkSegs([]).map(([t]) => t).join('')).toBe('no data');
    expect(rowText(fitRow([['abcdef']], 4))).toBe('abcd');
    expect(besides([[[['ab']]], [[['cd']]]]).map(rowText)).toEqual(['ab cd']);
  });
});

const SIZES = [[200, 80], [160, 50], [140, 50], [200, 60]] as const;

describe('framed board sizes', () => {
  for (const [w, h] of SIZES) {
    test(`${w}×${h}: every replay frame is exactly ${h} rows of ${w} cells (seeds 1..3)`, () => {
      for (const seed of [1, 2, 3]) for (const s of burstDemoRun(seed)) for (let f = 0; f < 4; f += 3) {
        const rows = plainBoard(renderBurstPanels(s, w, h, f));
        expect(rows.length).toBe(h);
        for (const r of rows) expect(Bun.stringWidth(r)).toBe(w);
      }
    });
  }
  test('terminal pick: ≥140×40 framed, smaller falls back to the line board', () => {
    expect(renderForTerminal(burstFixture('calm'), 200, 80, 0, false)[1]!.startsWith('┌─ Pressure')).toBe(true);
    expect(renderForTerminal(burstFixture('calm'), 120, 36, 0, false)[1]).toBe('Quiet · resources at rest · cloud off');
  });
});

describe('replay story (real planner over the test-universe world)', () => {
  for (const seed of [1, 2, 3]) {
    test(`seed ${seed}: calm → burst → review step → host cap → cloud card → early exit → receipt, in order`, () => {
      const run = burstDemoRun(seed);
      expect(run.length).toBe(DEMO_TICKS);
      const first = (p: (s: (typeof run)[number]) => boolean) => run.findIndex(p);
      const burst = first((s) => s.mode === 'burst');
      const handsBurst = first((s) => s.hands.some((x) => x.state === 'new'));
      const review = first((s) => s.lanes.some((l) => l.label === 'Review' && (l.steppedBy ?? 0) > 0));
      const cap = first((s) => s.hosts.some((x) => x.name === 'mshq' && x.used >= x.cap));
      const card = first((s) => s.hosts.some((x) => x.state === 'card'));
      const target = first((s) => s.mode === 'burst' && (s.landedPerHour.at(-1) ?? 0) >= 20);
      const exit = first((s) => s.mode === 'exiting');
      const done = first((s) => s.mode === 'done');
      expect(run.slice(0, 15).every((s) => s.mode === 'calm')).toBe(true);
      expect(burst).toBe(15);
      expect(handsBurst).toBeGreaterThanOrEqual(burst);
      for (const t of [review, cap, card, target, exit, done]) expect(t).toBeGreaterThan(burst);
      expect(exit).toBeLessThan(done);
      expect(done).toBeLessThan(DEMO_TICKS);
      expect(run[done]!.receipt?.durationLabel.endsWith('(early exit)')).toBe(true);
      expect(run.slice(done + 2).every((s) => s.hands.length === 6)).toBe(true);
    });
  }
  test('the board shows the planner rows it was given (no hand-made plan)', () => {
    const s = burstFixture('bursting');
    expect(s.plan?.length).toBeGreaterThan(0);
    expect(s.source).toBe('replay');
    const direct = planScale({ levels: {}, lastChangeAt: {}, pressures: pressures({ targetGapRatio: 2.5, readyBacklog: 40, hands: 6, readyPerHand: 2, judgeWaitMin: null, judgeWaitTargetMin: 30,
      judgeQueue: null, gateWaitMin: null, gateWaitTargetMin: 10, reviewWaitMin: null, reviewWaitTargetMin: 20, landQueue: null, landQueueTarget: 6, hoursToDeadline: null }),
    now: new Date('2026-11-26T03:30:00Z'), config: DEFAULT_BURST_CONFIG, spentUsd: 0, budgetUsd: 80, cloudApprovedUsd: 0, hoursLeft: 4, forecastMisses: true });
    const viaEngine = planBurst({ signals: { targetGapRatio: 2.5, readyBacklog: 40, hands: 6, readyPerHand: 2, judgeWaitMin: null, judgeWaitTargetMin: 30, judgeQueue: null,
      gateWaitMin: null, gateWaitTargetMin: 10, reviewWaitMin: null, reviewWaitTargetMin: 20, landQueue: null, landQueueTarget: 6, hoursToDeadline: null },
    active: null, config: DEFAULT_BURST_CONFIG, now: new Date('2026-11-26T03:30:00Z'), forecastMisses: true, hoursLeft: 4 });
    expect(viaEngine.plan).toEqual(direct);
    expect(direct[0]).toMatchObject({ lane: 'hands', from: 0, to: 2 });
  });
});

const EMPTY: LiveReadings = {
  now: new Date('2026-11-26T00:00:00Z'), release: null, planned: null, config: DEFAULT_BURST_CONFIG, active: null, lastReceipt: null,
  landedPerHour: null, greenPerHour: null, hands: null, hosts: null, measures: {}, landTarget: 20, gaps: ['planner (probe failed)', 'RES capacity (ENOENT)'], events: [],
};

describe('live snapshot with missing data', () => {
  test('every source missing → «no data» on the board, no throw, at every size', () => {
    const s = liveSnapshot(EMPTY, 0);
    expect(s.pressure).toBe(null);
    for (const [w, h] of [...SIZES, [120, 36], [80, 24]] as const) {
      const text = renderForTerminal(s, w, h, 0, false).join('\n');
      expect(text).toContain('no data');
    }
    const board = plainBoard(renderBurstPanels(s, 200, 80, 0)).join('\n');
    expect(board).toContain('hand pool not readable this refresh — no data');
    expect(board).toContain('RES capacity not readable this refresh — no data');
    expect(board).toContain('no data: planner (probe failed) · RES capacity (ENOENT)');
  });
  test('partial: hands measured, hosts missing', () => {
    const s = liveSnapshot({ ...EMPTY, hands: [{ host: 'TC', state: 'busy' }, { host: 'TC', state: 'idle' }] }, 1);
    const board = plainBoard(renderBurstPanels(s, 160, 50, 0)).join('\n');
    expect(board).toContain('1 working / 2 open');
    expect(board).toContain('RES capacity not readable this refresh — no data');
  });
});

describe('long run', () => {
  test('10 minutes of frames (300 snapshots × 4): flat memory, redraw in place (one clear only)', async () => {
    const writes: string[] = [];
    const io = { write: (t: string) => { if (t.includes('\x1b[2J')) writes.push(t); }, sleep: async () => {}, columns: () => 200, rows: () => 80 };
    await playBurstReplay(io, {});
    Bun.gc(true);
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < 2; i++) await playBurstReplay(io, { seed: 1 });
    Bun.gc(true);
    const growth = process.memoryUsage().heapUsed - before;
    expect(growth).toBeLessThan(8 * 1024 * 1024);
    expect(writes.length).toBe(3);
  });
});
