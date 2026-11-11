import { expect, test } from 'bun:test';
import { simMapReduceMultihost, type MapReduceSimInput } from './mapreduce-multihost-sim.js';

const base: MapReduceSimInput = {
  // Source: deterministic test fixture identity uses the gate's 40-character commit shape (NUMGUARD)
  runId: 'sim-mapreduce-run', head40: 'a'.repeat(40), base40: 'b'.repeat(40), seed: 'seed-0309',
  // Source: one retry and a high-enough fixture budget exercise both attempts without clipping (내부 문서 `pod-federation-mapreduce` §3, NUMGUARD)
  retryMax: 1, costLimit: 20, hosts: ['aws1', 'aws2'],
  pieces: [
    { id: 'piece-a', files: ['src/a.test.ts'], estimatedCost: 1, outcomes: ['complete'] },
    { id: 'piece-b', files: ['src/b.test.ts'], estimatedCost: 1, outcomes: ['failed', 'complete'] },
    { id: 'piece-c', files: ['src/c.test.ts'], estimatedCost: 1, outcomes: ['failed', 'failed'] },
  ],
};

test('SIM-MAPREDUCE: task fanout and gate shards produce the same deterministic receipt with retry and partial result', async () => {
  const observed = await simMapReduceMultihost(base);
  expect(observed.taskReceipt).toEqual(observed.gateReceipt);
  // Source: three pieces reserve two units each; observed attempts spend five units in this fixture (NUMGUARD)
  expect(observed.taskReceipt).toMatchObject({ seed: base.seed, costLimit: base.costLimit,
    reservedCost: 6, spentCost: 5, verdict: 'partial' });
  expect(observed.taskReceipt?.pieces.map((piece) => [piece.pieceId, piece.status, piece.attempts.length]))
    .toEqual([['piece-a', 'complete', 1], ['piece-b', 'complete', 2], ['piece-c', 'failed', 2]]);
  expect(observed.gateActions.filter((action) => action.kind === 'run')).toHaveLength(5);
  expect(observed.taskLaunches).toHaveLength(5);
  expect(observed.gateActions.filter((action) => action.kind === 'run').map(({ pieceId, host, attempt, costLimit }) => [pieceId, host, attempt, costLimit]).sort())
    .toEqual(observed.taskLaunches.map(({ pieceId, host, attempt, costLimit }) => [pieceId, host, attempt, costLimit]).sort());

  const replay = await simMapReduceMultihost({ ...base, runId: 'sim-mapreduce-replay' });
  expect(replay.taskReceipt).toEqual(observed.taskReceipt);
  expect(replay.gateReceipt).toEqual(observed.gateReceipt);
  expect(replay.gateActions.map(({ pieceId, host, attempt, costLimit, kind }) => [pieceId, host, attempt, costLimit, kind]))
    .toEqual(observed.gateActions.map(({ pieceId, host, attempt, costLimit, kind }) => [pieceId, host, attempt, costLimit, kind]));
});

test('SIM-MAPREDUCE: retry reservations enforce the shared cost ceiling before launches', async () => {
  // Source: budget admits one piece at two reserved units and rejects the next reservation (NUMGUARD)
  const observed = await simMapReduceMultihost({ ...base, runId: 'sim-mapreduce-budget', costLimit: 3 });
  expect(observed.taskReceipt).toEqual(observed.gateReceipt);
  expect(observed.taskReceipt).toMatchObject({ costLimit: 3, reservedCost: 2, spentCost: 1, verdict: 'partial' });
  expect(observed.taskReceipt?.pieces.map((piece) => [piece.pieceId, piece.status]))
    .toEqual([['piece-a', 'complete'], ['piece-b', 'budget-exceeded'], ['piece-c', 'budget-exceeded']]);
  expect(observed.taskLaunches.map((launch) => launch.pieceId)).toEqual(['piece-a']);
  expect(observed.gateActions.map((action) => action.kind)).toEqual(['run', 'unmeasured', 'unmeasured']);
});

test('SIM-MAPREDUCE: zero retry budget keeps failed first attempts partial and never relaunches', async () => {
  // Source: zero additional retries means each piece has at most its first attempt (내부 문서 `pod-federation-mapreduce` §3, NUMGUARD)
  const input: MapReduceSimInput = { ...base, runId: 'sim-mapreduce-no-retry', retryMax: 0,
    costLimit: 3, pieces: [base.pieces[0]!, { ...base.pieces[1]!, outcomes: ['failed'] }] };
  const observed = await simMapReduceMultihost(input);
  expect(observed.taskReceipt).toEqual(observed.gateReceipt);
  expect(observed.taskReceipt).toMatchObject({ reservedCost: 2, spentCost: 2, verdict: 'partial' });
  expect(observed.taskReceipt?.pieces.map((piece) => [piece.pieceId, piece.status, piece.attempts.length]))
    .toEqual([['piece-a', 'complete', 1], ['piece-b', 'failed', 1]]);
  expect(observed.taskLaunches).toHaveLength(2);
  expect(observed.gateActions.filter((action) => action.kind === 'run')).toHaveLength(2);
});
