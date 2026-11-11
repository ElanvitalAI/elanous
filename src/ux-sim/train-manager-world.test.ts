import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { simulateTrainManagerWorld, type TrainManagerWorldInput, type TrainManagerWorldPr } from './train-manager-world.js';

const base = 'a'.repeat(40);
const pr = (number: number, overrides: Partial<TrainManagerWorldPr> = {}): TrainManagerWorldPr => ({
  number, head: number.toString(16).padStart(40, '0'), baseRef: 'main', state: 'open', gate: 'passed', owner: `MVP-${number}`,
  files: [`src/feature-${number}.ts`], ...overrides,
});
const world = (prs: readonly TrainManagerWorldPr[], overrides: Partial<TrainManagerWorldInput> = {}): TrainManagerWorldInput => ({
  base, now: '2026-11-10T00:00:00.000Z', prs, ...overrides,
});

test('TRAIN-LOOP-AGENT: a fake GitHub queue tick uses the production train decision path', async () => {
  const result = await simulateTrainManagerWorld(world([pr(101), pr(102), pr(103, { gate: 'unmeasured' })], {
    slots: [{ host: 'aws1', slot: 1, expressOnly: false }, { host: 'gcp2', slot: 1, expressOnly: false }], groupLimit: 2,
  }));
  expect(result.mainBasePrs).toEqual([101, 102, 103]);
  expect(result.assignments).toEqual([{ stage: 'group', host: 'aws1', slot: 1, prs: ['101', '102'] }]);
  expect(result.landing.receipts.map(row => row.number)).toEqual([101, 102]);
  expect(result.trace.map(row => row.event)).toContain('github.snapshot');
  expect(result.trace.map(row => row.event)).toContain('train.tick');

  // The pinned operational snapshot runs the real manager decision functions in fake HOME;
  // the landing shell entrypoint runs against its GH_STUB and a temporary repository.
  const repo = resolve(import.meta.dir, '../..');
  const managerReplay = spawnSync(process.env.ELANOUS_PYTHON ?? 'python3', [
    resolve(repo, 'scripts/ux-sim/test-train-edge-operational-replay.py'),
  ], { cwd: repo, encoding: 'utf8' });
  expect(managerReplay.status, managerReplay.stderr || managerReplay.stdout).toBe(0);
  expect(JSON.parse(managerReplay.stdout).mainBaseFilter).toMatchObject({ kept: ['99022'], humanInterventions: 0 });
  const landingReplay = spawnSync('zsh', [resolve(repo, 'scripts/land-enqueue.test.sh')], { cwd: repo, encoding: 'utf8' });
  expect(landingReplay.status, landingReplay.stderr || landingReplay.stdout).toBe(0);
  expect(landingReplay.stdout).toContain('PASS land-enqueue classifier evidence');
});

test('TRAIN-BASE-MAIN-ONLY: the queue excludes unmeasured, non-main, and closed PRs', async () => {
  const result = await simulateTrainManagerWorld(world([
    pr(201), pr(202, { baseRef: 'release/0.3.9' }), pr(203, { baseRef: '' }), pr(204, { state: 'closed' }),
  ]));
  expect(result.mainBasePrs).toEqual([201]);
  expect(result.excludedBasePrs).toEqual([
    { pr: 202, reason: 'base-not-main' }, { pr: 203, reason: 'base-not-main' }, { pr: 204, reason: 'not-open' },
  ]);
  expect(result.assignments.flatMap(row => row.prs)).toEqual(['201']);
});

test('CONFLICT-FORECAST-LEDGER: fake merge-tree appends a deterministic conflict JSONL row', async () => {
  const result = await simulateTrainManagerWorld(world([
    pr(301, { files: ['src/shared.ts'] }), pr(302, { files: ['src/shared.ts'] }), pr(303, { files: ['src/other.ts'] }),
  ]));
  const rows = result.conflictForecastJsonl.trim().split('\n').map(line => JSON.parse(line));
  expect(rows).toEqual([{
    schema: 'conflict-forecast.v1', at: '2026-11-10T00:00:00.000Z', kind: 'pr-conflict', detector: 'overlap-evidence',
    pr: 301, head: pr(301).head, base, otherPr: 302, files: ['src/shared.ts'], conflict: true, owner: 'MVP-301',
  }]);
  expect(result.landing.receipts).toEqual([
    { number: 301, head: pr(301).head, verdict: 'pass' },
    { number: 302, head: pr(302).head, verdict: 'conflict' },
    { number: 303, head: pr(303).head, verdict: 'pass' },
  ]);
  expect(result.trace.map(row => row.event)).toContain('conflict.forecast');
});

test('HOTSPOT-RADIUS-ORDERING: the fake train lands a shared file in measured radius order', async () => {
  // Source: RFC-train-manager-loop-agent.md §5: S1 first, then wider hotspot radius.
  const result = await simulateTrainManagerWorld(world([
    pr(401, { files: ['src/hotspot.ts'], radius: 2 }),
    pr(402, { files: ['src/hotspot.ts'], radius: 8 }),
    pr(403, { files: ['src/hotspot.ts'], radius: 1, priority: 'S1' }),
  ]));
  expect(result.orderedPrs).toEqual([403, 402, 401]);
  expect(result.assignments.flatMap(row => row.prs)).toEqual(['403', '402', '401']);
  expect(result.landing.receipts.map(row => row.number)).toEqual([403, 402, 401]);
});

test('HOTSPOT-RADIUS-ORDERING: a partially measured hotspot refuses ordering', async () => {
  await expect(simulateTrainManagerWorld(world([
    pr(411, { files: ['src/hotspot.ts'], radius: 2 }),
    pr(412, { files: ['src/hotspot.ts'] }),
  ]))).rejects.toThrow('hotspot radius is only partially measured');
});

test('HOTSPOT-RADIUS-ORDERING: express, MUST, solo, and queue-fill share the measured order', async () => {
  // Source: RFC-train-manager-loop-agent.md §5: S1 first, then wider hotspot radius; train-manager.py dispatch lanes.
  const cases = [
    { lane: 'express', first: pr(501, { expressRank: 0 }), second: pr(502, { expressRank: 1 }),
      slots: [{ host: 'aws1', slot: 1, expressOnly: true }, { host: 'aws1', slot: 2, expressOnly: true }],
      stage: 'express' },
    { lane: 'MUST', first: pr(511, { mustRank: 0 }), second: pr(512, { mustRank: 1 }),
      slots: [{ host: 'aws1', slot: 1, expressOnly: false }], stage: 'group' },
    { lane: 'solo', first: pr(521, { solo: true, gate: 'unmeasured' }),
      second: pr(522, { solo: true, gate: 'unmeasured' }),
      slots: [{ host: 'aws1', slot: 1, expressOnly: false }, { host: 'aws1', slot: 2, expressOnly: false }],
      stage: 'preflight' },
    { lane: 'queue-fill', first: pr(531), second: pr(532),
      slots: [{ host: 'aws1', slot: 1, expressOnly: false }], stage: 'group' },
  ] as const;
  for (const scenario of cases) {
    const shared = 'src/shared-hotspot.ts';
    const before = await simulateTrainManagerWorld(world([
      { ...scenario.first, files: [shared] }, { ...scenario.second, files: [shared] },
    ], { slots: scenario.slots }));
    const after = await simulateTrainManagerWorld(world([
      { ...scenario.first, files: [shared], radius: 1 },
      { ...scenario.second, files: [shared], radius: 8 },
    ], { slots: scenario.slots }));
    expect(before.orderedPrs, scenario.lane).toEqual([scenario.first.number, scenario.second.number]);
    expect(after.orderedPrs, scenario.lane).toEqual([scenario.second.number, scenario.first.number]);
    expect(after.assignments.flatMap(row => row.prs), scenario.lane).toEqual([
      String(scenario.second.number), String(scenario.first.number),
    ]);
    expect(after.assignments.map(row => row.stage).every(stage => stage === scenario.stage), scenario.lane).toBe(true);
    if (scenario.lane === 'solo') expect(after.landing.receipts).toEqual([]);
    else expect(after.landing.receipts.map(row => row.number), scenario.lane).toEqual([
      scenario.second.number, scenario.first.number,
    ]);
  }
});

test('HOTSPOT-RADIUS-ORDERING: an unmeasured express solo runs preflight without entering the landing queue', async () => {
  // Source: train-manager.py express solo-gate path; a preflight assignment is not a landing receipt.
  const candidate = pr(541, { files: ['src/express-solo.ts'], radius: 8, expressRank: 0, solo: true, gate: 'unmeasured' });
  const slots = [{ host: 'aws1', slot: 1, expressOnly: true }];
  const preflight = await simulateTrainManagerWorld(world([candidate], { slots }));
  expect(preflight.assignments).toEqual([{ stage: 'preflight', host: 'aws1', slot: 1, prs: ['541'] }]);
  expect(preflight.landing.receipts).toEqual([]);
  const ready = await simulateTrainManagerWorld(world([{ ...candidate, gate: 'passed' }], { slots }));
  expect(ready.assignments).toEqual([{ stage: 'express', host: 'aws1', slot: 1, prs: ['541'] }]);
  expect(ready.landing.receipts.map(row => row.number)).toEqual([541]);
});
