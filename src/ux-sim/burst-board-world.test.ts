// BURST-BOARD sim world — seeded streams × edges through the shared widget-sim harness (+ FanoutBoard, Federation Board).
import { describe, expect, test } from 'bun:test';
import { renderBurstBoard } from '../tui/widgets/scenes/burst-board.js';
import { renderFederationBoard, type FederationBoardSnapshot } from '../tui/widgets/scenes/federation-board.js';
import { renderFanoutBoard, type FanoutAgent, type FanoutBoardProps } from '../tui/widgets/fanout-board.js';
import { runBurstWorld, type BurstWorldEdge } from './burst-board-world.js';
import { runWidgetSim, simRandom, type WidgetSimPane } from './widget-sim.js';

const PANES: WidgetSimPane[] = [{ width: 120, height: 36 }, { width: 80, height: 24 }];
const SEEDS = [1, 7, 42];
const EDGES: BurstWorldEdge[] = ['oscillation', 'card-withdrawn', 'host-down', 'budget-ceiling', 'zero-hands', 'hands-60', 'long-ids', 'clock-skew'];
const burst = { name: 'burst-board', render: renderBurstBoard, frames: 4 };

describe('burst board world', () => {
  for (const seed of SEEDS) {
    test(`seed ${seed}: calm → all-in → jam → scale → catch-up → exit fits, is stable, moves only on deltas`, () => {
      const world = runBurstWorld({ seed });
      const report = runWidgetSim(burst, world.map((f) => ({ label: `t${f.plan.tick}`, model: f.snapshot, still: f.still })), PANES);
      expect(report.violations).toEqual([]);
      const modes = new Set(world.map((f) => f.plan.mode));
      expect([...modes]).toEqual(['calm', 'burst', 'exiting', 'done']);
      const last = world.at(-1)!;
      expect(last.plan.openBurstHands).toBe(0);
      expect(renderBurstBoard(last.snapshot, 120).some((l) => l.startsWith('Receipt · burst'))).toBe(true);
    });
  }

  for (const edge of EDGES) {
    test(`edge ${edge}: no overflow, no instability`, () => {
      const world = runBurstWorld({ seed: 3, edges: [edge] });
      expect(runWidgetSim(burst, world.map((f) => ({ label: `t${f.plan.tick}`, model: f.snapshot, still: f.still })), PANES).violations).toEqual([]);
    });
  }

  test('width changes 120 ↔ 80 mid-stream', () => {
    const world = runBurstWorld({ seed: 9 });
    world.forEach((f, i) => {
      const width = i % 2 ? 80 : 120;
      const lines = renderBurstBoard(f.snapshot, width, i % 4);
      for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(width);
    });
  });

  test('numbers on screen are the planner numbers', () => {
    for (const f of runBurstWorld({ seed: 42 })) {
      const lines = renderBurstBoard(f.snapshot, 120, 3);
      for (const lane of f.plan.lanes) {
        const row = lines.find((l) => l.startsWith(` ${f.plan.lanes.indexOf(lane) + 1} ${lane.label}`))!;
        const cols = row.slice(18, 41).trim().split(/\s+/);
        expect(cols).toEqual([String(lane.now), '→', String(lane.plan), String(lane.queue)]);
      }
      expect(lines.some((l) => l.includes(`Spend $${f.plan.spendUsd.toFixed(2)} / $30`))).toBe(true);
    }
  });

  test('budget ceiling holds spend at $30 and says so', () => {
    const world = runBurstWorld({ seed: 5, edges: ['hands-60'], ticks: 160 });
    expect(Math.max(...world.map((f) => f.plan.spendUsd))).toBeLessThanOrEqual(30);
  });

  test('no rate, no fresh event, no new hand → all tween frames identical', () => {
    const f = runBurstWorld({ seed: 1 })[40]!;
    const frozen = { ...f.snapshot, freshEvent: false, hands: f.snapshot.hands.map((h) => ({ ...h, state: 'busy' as const })), lanes: f.snapshot.lanes.map((l) => ({ ...l, speed: 0, steppedBy: undefined })) };
    expect(runWidgetSim(burst, [{ label: 'frozen', model: frozen, still: true }], PANES).violations).toEqual([]);
  });

  test('identical snapshot → identical frame', () => {
    const f = runBurstWorld({ seed: 1 })[40]!;
    expect(renderBurstBoard(f.snapshot, 120, 2)).toEqual(renderBurstBoard(structuredClone(f.snapshot), 120, 2));
  });
});

describe('shared widget-sim: other widgets', () => {
  const panes: WidgetSimPane[] = [{ width: 120 }, { width: 80 }, { width: 40 }];
  test('FanoutBoard: seeded agent streams incl. long names and 30 children', () => {
    const rnd = simRandom(11);
    const states: FanoutAgent['state'][] = ['running', 'done', 'failed', 'waiting'];
    const steps = Array.from({ length: 40 }, (_, i) => {
      const children: FanoutAgent[] = Array.from({ length: 1 + (i % 30) }, (_, k) => ({
        name: k % 7 === 0 ? `에이전트-${'long'.repeat(10)}-${k}` : `agent ${k}`,
        modelTail: 'terra', state: states[Math.floor(rnd() * 4)]!, progress: rnd() < 0.2 ? null : rnd(), elapsedMs: Math.floor(rnd() * 4e6),
        lastLine: `line ${'x'.repeat(Math.floor(rnd() * 200))}`,
      }));
      const model: FanoutBoardProps = { parent: { name: 'OP', modelTail: 'terra', state: 'running' }, children };
      return { label: `s${i}`, model };
    });
    expect(runWidgetSim({ name: 'fanout', render: (m: FanoutBoardProps, w: number) => renderFanoutBoard(m, w) }, steps, panes).violations).toEqual([]);
  });

  test('Federation Board: seeded KPI streams incl. zero targets and huge loads', () => {
    const rnd = simRandom(13);
    const steps = Array.from({ length: 40 }, (_, i) => {
      const model: FederationBoardSnapshot = {
        release: i % 9 === 0 ? `0.3.${i}-${'rc'.repeat(30)}` : `0.3.${i}`,
        landedPerHour: Math.floor(rnd() * 40), landTarget: i % 13 === 0 ? 0 : 20,
        greenPerHour: Math.floor(rnd() * 30), greenTarget: 10,
        seats: { working: Math.floor(rnd() * 20), idle: Math.floor(rnd() * 5), blocked: Math.floor(rnd() * 3) },
        handsOpen: Math.floor(rnd() * 60),
        hostLoad: { host: 'node-b', value: Math.floor(rnd() * 200), max: 64, threshold: 40 },
        releaseSteps: [{ label: 'Rehearse', state: 'done' }, { label: 'Cut', state: i % 2 ? 'active' : 'todo', note: 'n'.repeat(i * 3) }],
      };
      return { label: `s${i}`, model };
    });
    expect(runWidgetSim({ name: 'federation', render: (m: FederationBoardSnapshot, w: number) => renderFederationBoard(m, w) }, steps, panes).violations).toEqual([]);
  });
});
