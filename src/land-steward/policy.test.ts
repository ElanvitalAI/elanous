import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrInfo } from '../land-graph/land-graph.js';
import { loadLandPolicy, parseLandPolicy, pinOrder, policyOrder } from './policy.js';
import { landOrder } from '../land-graph/land-graph.js';
import { stewardDeps } from './agent.js';

const pr = (n: number, files: string[]): PrInfo => ({ number: n, head: `h${n}`, base: 'main', draft: false, state: 'OPEN', title: `pr ${n}`, author: 'UX', files, headRef: `b${n}`, createdAt: '2026-11-27T05:00:00Z' });

describe('land-steward policy pack — lane order', () => {
  test('the shipped pack parses (mode train · no pins)', () => {
    expect(loadLandPolicy()).toEqual({ laneOrder: { mode: 'train', pins: [] } });
  });
  test('pins re-sequence their PRs inside the slots they hold; other PRs keep their place', () => {
    const p = parseLandPolicy('lane_order:\n  mode: pr-number\n  pins:\n    - { file: src/a.ts, prs: [103, 101] }\n')!;
    const prs = [pr(101, ['src/a.ts']), pr(102, ['src/b.ts']), pr(103, ['src/a.ts'])];
    expect(policyOrder(p)(prs, [], Date.parse('2026-11-27T10:00:00Z')).map(x => x.number)).toEqual([103, 102, 101]);
  });
  test('a PR pinned twice is pinned once — the order stays a permutation (Terra #40444 must-1)', () => {
    const p = parseLandPolicy('lane_order:\n  mode: pr-number\n  pins:\n    - { file: src/a.ts, prs: [3, 3, 1] }\n')!;
    expect(p.laneOrder.pins).toEqual([{ file: 'src/a.ts', prs: [3, 1] }]);
    const prs = [pr(1, ['src/a.ts']), pr(2, ['src/a.ts']), pr(3, ['src/a.ts'])];
    const out = policyOrder(p)(prs, [], Date.parse('2026-11-27T10:00:00Z')).map(x => x.number);
    expect([...out].sort()).toEqual([1, 2, 3]);
    expect(out).toEqual([3, 2, 1]);
  });
  test('missing file · bad YAML · unknown mode · malformed pin → null or dropped', () => {
    expect(loadLandPolicy(join(mkdtempSync(join(tmpdir(), 'lp-')), 'none.yaml'))).toBeNull();
    expect(parseLandPolicy('lane_order: [')).toBeNull();
    expect(parseLandPolicy('lane_order:\n  mode: random\n')).toBeNull();
    expect(parseLandPolicy('lane_order:\n  mode: train\n  pins:\n    - { file: x, prs: [1] }\n    - { prs: [1, 2] }\n')).toEqual({ laneOrder: { mode: 'train', pins: [] } });
  });
  test('a land run (CLI · steward shadow/off) is reordered ONLY by explicit pins — no pins → null → the body order exactly (Terra #40447 must-fix 1)', () => {
    expect(pinOrder(null)).toBeNull();
    expect(pinOrder(parseLandPolicy('lane_order:\n  mode: train\n  pins: []\n'))).toBeNull();
    expect(pinOrder(loadLandPolicy())).toBeNull();
    const prs = [pr(201, ['src/a.ts']), pr(202, ['src/b.ts']), pr(203, ['src/a.ts'])];
    const now = Date.parse('2026-11-27T10:00:00Z');
    const pinned = pinOrder(parseLandPolicy('lane_order:\n  mode: train\n  pins:\n    - { file: src/a.ts, prs: [203, 201] }\n'))!;
    expect(pinned(prs, [], now).map(x => x.number)).toEqual([203, 202, 201]);
    expect(landOrder(prs, [], now).map(x => x.number)).toEqual([201, 202, 203]);
  });
  test('steward live uses the pack order; no pack → the built-in train order; shadow leaves the deps as given', () => {
    const base = { order: undefined } as unknown as Parameters<typeof stewardDeps>[0];
    const pack = parseLandPolicy('lane_order:\n  mode: pr-number\n')!;
    expect(typeof stewardDeps(base, 'live', () => {}, pack).order).toBe('function');
    expect(typeof stewardDeps(base, 'live', () => {}, null).order).toBe('function');
    expect(stewardDeps(base, 'shadow', () => {}, pack).order).toBeUndefined();
  });
});
