import { describe, expect, test } from 'bun:test';
import { durationLabel, edgeBetween, kstClock, replayDelayMs, sceneAt, type SceneEdge, type TraversalStep } from './live-run-scene';

const nodes = ['plan', 'implement', 'gate', 'investigate', 'review', 'land'];
const edges: SceneEdge[] = [
  { id: 'e0', from: 'plan', to: 'implement', outcomes: ['pass'] },
  { id: 'e1', from: 'implement', to: 'gate', outcomes: ['pass'] },
  { id: 'e2', from: 'gate', to: 'review', outcomes: ['pass'] },
  { id: 'e3', from: 'gate', to: 'investigate', outcomes: ['fail'] },
  { id: 'e4', from: 'investigate', to: 'implement', outcomes: ['pass'] },
  { id: 'e5', from: 'review', to: 'land', outcomes: ['pass'] },
];
const at = (minute: number) => new Date(Date.UTC(2026, 9, 8, 0, minute)).toISOString();
const steps: TraversalStep[] = [
  { node: 'plan', outcome: 'pass', at: at(0), durationMs: 60_000, visit: 1 },
  { node: 'implement', outcome: 'pass', at: at(1), durationMs: 120_000, visit: 1 },
  { node: 'gate', outcome: 'fail', at: at(3), durationMs: 30_000, visit: 1 },
  { node: 'investigate', outcome: 'pass', at: at(4), durationMs: 10_000, visit: 1 },
  { node: 'implement', outcome: 'pass', at: at(5), durationMs: 60_000, visit: 2 },
  { node: 'gate', outcome: null, at: at(6), durationMs: null, visit: 2 },
];

describe('sceneAt', () => {
  test('nothing played: every node pending', () => {
    const frame = sceneAt(nodes, edges, steps, -1);
    expect(Object.values(frame.nodeState).every((state) => state === 'pending')).toBe(true);
    expect(frame.activeEdge).toBeNull();
  });

  test('gate fail lights the back route and marks the gate red', () => {
    const frame = sceneAt(nodes, edges, steps, 3);
    expect(frame.nodeState.gate).toBe('failed');
    expect(frame.nodeState.investigate).toBe('passed');
    expect(frame.activeEdge).toBe('e3');
    expect([...frame.takenEdges].sort()).toEqual(['e0', 'e1', 'e3']);
    expect(frame.nodeState.review).toBe('pending');
  });

  test('revisits count up and the back edge is taken', () => {
    const frame = sceneAt(nodes, edges, steps, 4);
    expect(frame.visits.implement).toBe(2);
    expect(frame.activeEdge).toBe('e4');
    expect(frame.takenEdges.has('e4')).toBe(true);
  });

  test('a live step with no outcome yet pulses as running; entering forces running', () => {
    expect(sceneAt(nodes, edges, steps, 5).nodeState.gate).toBe('running');
    expect(sceneAt(nodes, edges, steps, 2, true).nodeState.gate).toBe('running');
    expect(sceneAt(nodes, edges, steps, 2, false).nodeState.gate).toBe('failed');
  });

  test('cursor past the end clamps to the last step', () => {
    expect(sceneAt(nodes, edges, steps, 99).cursor).toBe(5);
  });
});

describe('helpers', () => {
  test('edgeBetween prefers the outcome-matching edge', () => {
    const parallel: SceneEdge[] = [
      { id: 'a', from: 'x', to: 'y', outcomes: ['fail'] },
      { id: 'b', from: 'x', to: 'y', outcomes: ['rework'] },
    ];
    expect(edgeBetween(parallel, 'x', 'rework', 'y')?.id).toBe('b');
    expect(edgeBetween(parallel, 'x', 'other', 'y')?.id).toBe('a');
    expect(edgeBetween(parallel, 'y', 'pass', 'x')).toBeNull();
  });

  test('replay pacing is squeezed and divided by speed', () => {
    expect(replayDelayMs(steps, 0, 1)).toBe(1000);
    expect(replayDelayMs(steps, 0, 4)).toBe(250);
    expect(replayDelayMs(steps, 5, 1)).toBe(900);
  });

  test('KST clock and duration labels', () => {
    expect(kstClock('2026-10-08T00:05:07.000Z')).toBe('09:05:07');
    expect(kstClock('nope')).toBe('—');
    expect(durationLabel(450)).toBe('450ms');
    expect(durationLabel(75_000)).toBe('1분 15초');
    expect(durationLabel(null)).toBe('—');
  });
});
