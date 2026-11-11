import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { receiptFromWorld, runWorldRegressionSuite, type SuiteReceipt } from './world-regression-suite.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function suite(): string {
  const root = mkdtempSync(join(tmpdir(), 'world-regression-suite-'));
  roots.push(root);
  writeFileSync(join(root, 'suite.json'), JSON.stringify({ durationTolerancePercent: 10 })); // Source: fixture chooses a tight explicit tolerance to test the comparison boundary.
  for (const id of ['incident-one', 'incident-two']) {
    const path = join(root, id);
    mkdirSync(path);
    writeFileSync(join(path, 'world.yaml'), `world: ${id}\n`);
    writeFileSync(join(path, 'scenario.yaml'), `world: ${id}\nsteps: []\n`);
  }
  return root;
}

const receipt = (durationMs = 100): SuiteReceipt => ({ // Source: fixture uses 100 ms so 10% tolerance is directly observable.
  pass: true, steps: [{ id: 'inject', outcome: 'ok', invariant: 'pass', durationMs }], eventKinds: ['world-event'],
});

test('suite records baselines, runs every scenario twice for sim, and reports only changed steps', async () => {
  const root = suite();
  const runs: string[] = [];
  const run = async (item: { id: string }) => { runs.push(item.id); return receipt(); };
  const updated = await runWorldRegressionSuite({ folder: root, target: 'sim', updateBaseline: true, run });
  expect(updated).toMatchObject({ pass: true, scenarios: 2, measurement: 'measured', differences: [] });
  expect(runs).toEqual(['incident-one', 'incident-one', 'incident-two', 'incident-two']);
  expect(JSON.parse(readFileSync(join(root, 'incident-one', 'baseline.sim.json'), 'utf8')).receipt).toEqual(receipt());
  const compared = await runWorldRegressionSuite({ folder: root, target: 'sim', run: async (item) => item.id === 'incident-two'
    ? { pass: false, steps: [{ id: 'inject', outcome: 'error', invariant: 'fail', durationMs: 115 }], eventKinds: ['world-event'] } : receipt() });
  expect(compared.pass).toBe(false);
  expect(compared.differences.map((difference) => `${difference.scenario}:${difference.field}`)).toEqual([
    'incident-two:pass', 'incident-two:inject.outcome',
    'incident-two:inject.invariant', 'incident-two:inject.durationMs',
  ]);
});

test('missing baseline never passes, and an unconnected real target is unmeasured', async () => {
  const root = suite();
  const missing = await runWorldRegressionSuite({ folder: root, target: 'sim', run: async () => receipt() });
  expect(missing).toMatchObject({ pass: false, scenarios: 2, differences: [
    { scenario: 'incident-one', field: 'baseline' }, { scenario: 'incident-two', field: 'baseline' },
  ] });
  const real = await runWorldRegressionSuite({ folder: root, target: 'real' });
  expect(real).toMatchObject({ pass: false, measurement: 'unmeasured', scenarios: 2 });
  expect(real.differences.every((difference) => difference.actual === 'unmeasured: target runner unavailable')).toBe(true);
});

test('sim nondeterminism is named at the changed step and never updates its baseline', async () => {
  const root = suite();
  let calls = 0;
  const result = await runWorldRegressionSuite({ folder: root, target: 'sim', updateBaseline: true,
    run: async () => { calls++; return { ...receipt(), steps: [{ ...receipt().steps[0]!, outcome: calls % 2 ? 'ok' : 'fail' }] }; } });
  expect(result.pass).toBe(false);
  expect(result.differences[0]?.field).toBe('nondeterministic.inject.outcome');
  expect(() => readFileSync(join(root, 'incident-one', 'baseline.sim.json'))).toThrow();
});

test('sim replay failure alone is nondeterminism and cannot create a baseline', async () => {
  const root = suite();
  let calls = 0;
  const result = await runWorldRegressionSuite({ folder: root, target: 'sim', updateBaseline: true,
    run: async () => ({ ...receipt(), pass: ++calls % 2 === 1 }) });
  expect(result.pass).toBe(false);
  expect(result.differences[0]?.field).toBe('nondeterministic.pass');
  expect(() => readFileSync(join(root, 'incident-one', 'baseline.sim.json'))).toThrow();
});

test('real uses a separate baseline and duration inside tolerance produces no difference', async () => {
  const root = suite();
  const seeded = await runWorldRegressionSuite({ folder: root, target: 'real', updateBaseline: true,
    run: async () => receipt() });
  expect(seeded).toMatchObject({ pass: true, measurement: 'measured', scenarios: 2 });
  // Source: the suite fixture declares a ten-percent duration tolerance; 109 ms stays inside it.
  const compared = await runWorldRegressionSuite({ folder: root, target: 'real', run: async () => receipt(109) });
  expect(compared).toMatchObject({ pass: true, differences: [] });
  expect(() => readFileSync(join(root, 'incident-one', 'baseline.sim.json'))).toThrow();
});

test('step additions and removals are reported by the ordered step IDs', async () => {
  const root = suite();
  await runWorldRegressionSuite({ folder: root, target: 'sim', updateBaseline: true, run: async () => receipt() });
  const changed = await runWorldRegressionSuite({ folder: root, target: 'sim', run: async () => ({ ...receipt(),
    steps: [{ id: 'replacement', outcome: 'ok', invariant: 'pass', durationMs: 100 }] }) });
  expect(changed.differences.map((difference) => difference.field)).toEqual(['step.ids', 'step.ids']);
});

test('inserted steps do not create false outcome differences and repeated IDs remain distinct', async () => {
  const root = suite();
  const original: SuiteReceipt = { pass: true, eventKinds: ['event'], steps: [
    { id: 'repeat', outcome: 'first', invariant: 'pass', durationMs: null },
    { id: 'repeat', outcome: 'second', invariant: 'pass', durationMs: null },
  ] };
  await runWorldRegressionSuite({ folder: root, target: 'real', updateBaseline: true, run: async () => original });
  const inserted = await runWorldRegressionSuite({ folder: root, target: 'real', run: async () => ({ ...original,
    steps: [{ id: 'new', outcome: 'new', invariant: 'pass', durationMs: null }, ...original.steps] }) });
  expect(inserted.differences.map((difference) => difference.field)).toEqual(['step.ids', 'step.ids']);
  const repeated = await runWorldRegressionSuite({ folder: root, target: 'real', run: async () => ({ ...original,
    steps: [original.steps[0]!, { ...original.steps[1]!, outcome: 'changed' }] }) });
  expect(repeated.differences.map((difference) => difference.field)).toEqual(['repeat#2.outcome', 'repeat#2.outcome']);
});

test('current suite tolerance governs comparison even when the saved baseline had a wider tolerance', async () => {
  const root = suite();
  await runWorldRegressionSuite({ folder: root, target: 'real', updateBaseline: true, run: async () => receipt() });
  // Source: the fixture tightens its declared tolerance from ten percent to five percent before comparison.
  writeFileSync(join(root, 'suite.json'), JSON.stringify({ durationTolerancePercent: 5 }));
  const compared = await runWorldRegressionSuite({ folder: root, target: 'real', run: async () => receipt(108) });
  expect(compared.differences.map((difference) => difference.field)).toEqual(['inject.durationMs', 'inject.durationMs']);
});

test('missing or invalid duration in baseline and runner receipts fails before comparison', async () => {
  const root = suite();
  await runWorldRegressionSuite({ folder: root, target: 'real', updateBaseline: true, run: async () => receipt() });
  const path = join(root, 'incident-one', 'baseline.real.json');
  const malformed = JSON.parse(readFileSync(path, 'utf8')) as { receipt: { steps: Array<Record<string, unknown>> } };
  delete malformed.receipt.steps[0]!.durationMs;
  writeFileSync(path, JSON.stringify(malformed));
  await expect(runWorldRegressionSuite({ folder: root, target: 'real', run: async () => receipt(200) }))
    .rejects.toThrow('invalid suite receipt');
  await expect(runWorldRegressionSuite({ folder: root, target: 'sim', updateBaseline: true,
    run: async () => ({ ...receipt(), steps: [{ ...receipt().steps[0]!, durationMs: Number.NaN }] }) }))
    .rejects.toThrow('invalid suite receipt');
});

test('runner receipts reject non-JSON fields before persistence', async () => {
  const root = suite();
  await expect(runWorldRegressionSuite({ folder: root, target: 'sim', updateBaseline: true,
    run: async () => ({ ...receipt(), extra: undefined }) }))
    .rejects.toThrow('only JSON values');
});

test('an already failing baseline never makes a failing scenario a passing suite', async () => {
  const root = suite();
  await runWorldRegressionSuite({ folder: root, target: 'real', updateBaseline: true, run: async () => receipt() });
  for (const id of ['incident-one', 'incident-two']) {
    const path = join(root, id, 'baseline.real.json');
    const saved = JSON.parse(readFileSync(path, 'utf8')) as { receipt: { pass: boolean } };
    saved.receipt.pass = false;
    writeFileSync(path, JSON.stringify(saved));
  }
  const result = await runWorldRegressionSuite({ folder: root, target: 'real', run: async () => ({ ...receipt(), pass: false }) });
  expect(result).toMatchObject({ pass: false, differences: [
    { scenario: 'incident-one', field: 'scenario.pass' }, { scenario: 'incident-two', field: 'scenario.pass' },
  ] });
});

test('real runner may use a declared custom invariant string and its change is compared', async () => {
  const root = suite();
  const custom = { ...receipt(), steps: [{ ...receipt().steps[0]!, invariant: 'payment-ledger-balanced' }] };
  await runWorldRegressionSuite({ folder: root, target: 'real', updateBaseline: true, run: async () => custom });
  const changed = await runWorldRegressionSuite({ folder: root, target: 'real', run: async () => ({ ...custom,
    steps: [{ ...custom.steps[0]!, invariant: 'payment-ledger-drifted' }] }) });
  expect(changed.differences.map((difference) => difference.field)).toEqual(['inject.invariant', 'inject.invariant']);
});

test('a later nondeterministic case leaves every baseline untouched during update', async () => {
  const root = suite();
  let secondRuns = 0;
  const result = await runWorldRegressionSuite({ folder: root, target: 'sim', updateBaseline: true,
    run: async (item) => item.id === 'incident-two' && ++secondRuns % 2 === 0
      ? { ...receipt(), steps: [{ ...receipt().steps[0]!, outcome: 'different' }] } : receipt() });
  expect(result.pass).toBe(false);
  expect(result.differences[0]?.field).toBe('nondeterministic.inject.outcome');
  for (const id of ['incident-one', 'incident-two'])
    expect(() => readFileSync(join(root, id, 'baseline.sim.json'))).toThrow();
});

test('a later baseline rename failure restores an earlier baseline', async () => {
  const root = suite();
  await runWorldRegressionSuite({ folder: root, target: 'real', updateBaseline: true, run: async () => receipt() });
  const first = join(root, 'incident-one', 'baseline.real.json');
  const second = join(root, 'incident-two', 'baseline.real.json');
  const original = readFileSync(first, 'utf8');
  rmSync(second);
  mkdirSync(second);
  await expect(runWorldRegressionSuite({ folder: root, target: 'real', updateBaseline: true,
    run: async () => receipt(150) })).rejects.toThrow(); // Source: a changed fixture duration distinguishes rollback from the original baseline.
  expect(readFileSync(first, 'utf8')).toBe(original);
  expect(() => readFileSync(`${first}.new`, 'utf8')).toThrow();
});

test('receipt projection removes run ID, wall time, and temporary paths while retaining simulated duration', () => {
  const first = receiptFromWorld({ pass: true, devices: [], observations: [{ event: 'payment',
    verdict: 'ok runId=run-a at 2026-11-09T10:00:00Z /tmp/world-a/result' }],
    recovery: { observations: [{ kind: 'monkey', faultAtMs: 0, faultVerdict: 'killed', recoveredAtMs: 50,
      recoveryVerdict: 'recovered', recoveryMs: 50, metrics: { hitlCount: 0, lostLedgerRows: 0, schedulableCpuMillicores: 0 } }],
      timeline: [{ atMs: 0, kind: 'fault-start', target: 'app' }], injections: [] } });
  const second = receiptFromWorld({ pass: true, devices: [], observations: [{ event: 'payment',
    verdict: 'ok runId=run-b at 2026-11-09T11:00:00Z /tmp/world-b/result' }],
    recovery: { observations: [{ kind: 'monkey', faultAtMs: 0, faultVerdict: 'killed', recoveredAtMs: 50,
      recoveryVerdict: 'recovered', recoveryMs: 50, metrics: { hitlCount: 0, lostLedgerRows: 0, schedulableCpuMillicores: 0 } }],
      timeline: [{ atMs: 0, kind: 'fault-start', target: 'app' }], injections: [] } });
  expect(first).toEqual(second);
  expect(first.steps[1]?.durationMs).toBe(50);
});

test('world receipt uses each observed invariant and simulated duration instead of the aggregate verdict', () => {
  const projected = receiptFromWorld({ pass: false, devices: [], observations: [
    { event: 'paid', verdict: 'ok', invariant: 'pass', durationMs: 30 },
    { event: 'refund', verdict: 'error', invariant: 'fail', durationMs: 70 },
  ] });
  expect(projected.steps).toEqual([
    { id: 'paid', outcome: 'ok', invariant: 'pass', durationMs: 30 },
    { id: 'refund', outcome: 'error', invariant: 'fail', durationMs: 70 },
  ]);
});
