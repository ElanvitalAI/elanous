import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runReleaseSimGateReceiptSeam } from './release-sim-rig.js';
import { buildGateSweepCertificate, planGateSweepAppend, simGateReceiptFileClosureCas, type GateSweepCertificate } from './gate-receipt-file-closure-cas.js';
import { auditGateFileReceiptSet, gateFileReceiptClosureDigest, gateFileReceiptIdentityFromClosure, gateFileReceiptKey, planGateFileReceipts, type GateFileReceiptIdentity, type GateFileReceipt } from '../../scripts/release-loop/gate-file-receipts.js';
import { testsReachingChanged, type ClosureTree } from '../../scripts/release-loop/gate-closure.js';
import { readGateFileReceipt, readGateFileReceiptHistory, saveGateFileReceipt } from '../../scripts/release-loop/gate-shard-receipts.js';
import { savePassingGateFileReceipts } from '../../scripts/release-loop/gate-runtime.js';

const TRAIN = '1'.repeat(40), CUT = '2'.repeat(40), IMAGE = 'sha256:' + 'a'.repeat(64);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
// 출처: 내부 문서 `RFC-release-gate-file-receipts-2026-11-08` § thresholds are measured and recorded per sweep certificate.
const FIXTURE_SWEEP_MAX_AGE_MS = 100;
// 출처: 내부 문서 `RFC-release-gate-file-receipts-2026-11-08` § full sweep dirty-ratio criterion.
const FIXTURE_SWEEP_MAX_DIRTY_RATIO = 0.25;
// 출처: test fixture keeps one removed file below the configured full-sweep ratio to exercise its interference neighbor.
const FIXTURE_DELETION_DIRTY_RATIO = 0.75;
// 출처: 내부 문서 `RFC-release-gate-file-receipts-2026-11-08` § supplemental work matches sweep concurrency.
const FIXTURE_SWEEP_CONCURRENCY = 8;
// 출처: RFC-release-gate-file-receipts § same fixed Pod profile reports this observed executor concurrency.
const FIXTURE_EXECUTOR_CONCURRENCY = 24;
// 출처: mismatch fixture injects one worker above the requested profile.
const FIXTURE_CONCURRENCY_DRIFT = 1;
const runSupplemental = (input: { tests: string[]; priorCommit: string; commit: string; selectedFiles: string[]; concurrency: number }, outcome: 'pass' | 'fail' | 'unmeasured') =>
  (() => {
    const stage = runReleaseSimGateReceiptSeam({ stage: 'append-supplemental', tests: input.tests, receipts: [], priorCommit: input.priorCommit,
      commit: input.commit, selectedFiles: input.selectedFiles, requestedSweepConcurrency: input.concurrency,
      executorWorkerCount: FIXTURE_EXECUTOR_CONCURRENCY }, () => ({ gateOutcome: outcome }));
    return { aggregate: stage.aggregate === 'complete' ? 'complete' as const : 'incomplete' as const,
      gateOutcome: stage.gateOutcome, publishDecision: stage.publishDecision, executedConcurrency: stage.observedSweepConcurrency ?? 0,
      plan: { fullSweep: stage.plan.fullSweep, rerunShardIds: stage.plan.rerunShardIds } };
  })();

function identity(file: string, deps: readonly string[], changed = false): GateFileReceiptIdentity {
  const closureFiles = [file, ...deps].sort();
  const contentHashes = Object.fromEntries(closureFiles.map((path) => [path, hash(path + (changed && path === deps[0] ? ':changed' : ''))]));
  return { file, closureFiles, contentHashes, imageDigest: IMAGE };
}

function priorReceipt(row: GateFileReceiptIdentity): GateFileReceipt {
  const closureDigest = gateFileReceiptClosureDigest(row);
  const key = hash(JSON.stringify([row.file, closureDigest, row.imageDigest]));
  return { file: row.file, closureFiles: [...row.closureFiles], closureDigest, imageDigest: row.imageDigest, key,
    ...(row.opaqueReasons?.length ? { opaqueReasons: [...row.opaqueReasons] } : {}),
    sourceHead40: TRAIN, outcome: 'pass', evidence: { file: row.file, pass: 1, fail: 0 } };
}

test.each([
  { sourceRunId: 'c159bb8d', changedIndex: 0, neighborIndex: 8 },
  { sourceRunId: '1475eed8', changedIndex: 1, neighborIndex: 9 },
])('three-commit append replay for $sourceRunId remeasures the event-specific closure and carries file receipts', (fixture) => {
  const { sourceRunId, changedIndex, neighborIndex } = fixture;
  const prior = Array.from({ length: 6674 }, (_, index) => identity(`test/suite-${index}.test.ts`,
    index < 2 ? ['src/shared/changed.ts'] : [`src/module-${index}.ts`]));
  const priorReceipts = prior.map(priorReceipt);
  const appended = prior.map((row, index) => index === changedIndex ? identity(row.file, ['src/shared/changed.ts'], true) : row);
  appended.push(identity('test/new-contract.test.ts', ['src/new-contract.ts']));
  const isolated = [appended[changedIndex]!, appended[6674]!];

  const observed = simGateReceiptFileClosureCas({ sourceRunId, trainHead40: TRAIN, cutHead40: CUT, imageDigest: IMAGE, prior, priorReceipts, appended, isolated,
    interference: { [`test/suite-${changedIndex}.test.ts`]: [`test/suite-${neighborIndex}.test.ts`] }, runSupplemental });

  expect(observed.appendPlan.reuse).toHaveLength(6673);
  expect(observed.appendPlan.measure.map((row) => row.file).sort()).toEqual(['test/new-contract.test.ts', `test/suite-${changedIndex}.test.ts`]);
  expect(observed.measuredAfterAppend.every((row) => row.file && row.key && row.closureDigest && row.imageDigest === IMAGE)).toBe(true);
  expect(observed.measuredAfterAppend).toHaveLength(3);
  expect(observed.measuredAfterAppend.every((row) => row.sourceHead40 === CUT)).toBe(true);
  expect(auditGateFileReceiptSet({ identities: appended, receipts: observed.carriedToCut })).toMatchObject({ ok: true });
  expect(auditGateFileReceiptSet({ identities: appended, receipts: observed.carriedToCut.slice(1) })).toMatchObject({ ok: false, reason: 'receipt inventory mismatch' });
  expect(observed.cutPlan.measure).toEqual([]);
  expect(observed.cutPlan.reuse).toHaveLength(6675);
  expect(observed.carriedToCut.find((row) => row.file === 'test/suite-3.test.ts')).toMatchObject({ sourceHead40: TRAIN, carriedToHead40: CUT });
  expect(observed.carriedToCut.find((row) => row.file === `test/suite-${changedIndex}.test.ts`)).toMatchObject({ sourceHead40: CUT, carriedToHead40: CUT });
  expect(observed.isolatedPlan.measure).toHaveLength(2);
  expect(observed.isolatedResults.every((row) => row.lane === 'isolated-recheck')).toBe(true);
  expect(observed.isolatedResults.map((row) => (row.evidence as { sourceRunId: string }).sourceRunId)).toEqual([sourceRunId, sourceRunId]);
  expect(auditGateFileReceiptSet({ identities: isolated, receipts: observed.isolatedResults }).ok).toBe(true);
  expect(observed.sweepCertificate).toMatchObject({ sourceHead40: TRAIN, imageDigest: IMAGE, thresholdSource: 'fixture: measured sweep policy' });
  expect(Object.keys(observed.sweepCertificate.fileKeys)).toHaveLength(6674);
  expect(observed.refreshedSweepCertificate).toMatchObject({ sourceHead40: CUT, imageDigest: IMAGE });
  expect(Object.keys(observed.refreshedSweepCertificate?.fileKeys ?? {})).toHaveLength(6675);
  expect(observed.refreshedSweepCertificate?.measuredAt).toBe(1_000);
  expect(observed.appendInvalidation).toMatchObject({ dirtyFiles: ['test/new-contract.test.ts', `test/suite-${changedIndex}.test.ts`],
    supplementalFiles: ['test/new-contract.test.ts', `test/suite-${changedIndex}.test.ts`, `test/suite-${neighborIndex}.test.ts`].sort(),
    fullSweepRequired: false });
  expect(observed.appendInvalidation.supplementalConcurrency).toBe(observed.sweepCertificate.sweepConcurrency);
  expect(observed.supplementalGate).toMatchObject({ gateOutcome: 'pass', publishDecision: 'eligible' });
});

test('sweep certificate invalidates all files for image, dirty-ratio, or measured-age limits', () => {
  const rows = [identity('test/a.test.ts', ['src/a.ts']), identity('test/b.test.ts', ['src/b.ts'])];
  const keys = Object.fromEntries(rows.map((row) => [row.file, gateFileReceiptKey(row)!]));
  const certificate: GateSweepCertificate = { sourceHead40: TRAIN, imageDigest: IMAGE, fileKeys: keys,
    sweepConcurrency: FIXTURE_SWEEP_CONCURRENCY, measuredAt: 1_000, maxAgeMs: FIXTURE_SWEEP_MAX_AGE_MS,
    maxDirtyRatio: FIXTURE_SWEEP_MAX_DIRTY_RATIO, thresholdSource: 'fixture: measured policy record' };
  const sameFilesNewImage = rows.map((row) => ({ ...row, imageDigest: 'sha256:' + 'b'.repeat(64) }));
  expect(planGateSweepAppend({ certificate, current: sameFilesNewImage, interference: {}, now: 1_050, sweepConcurrency: FIXTURE_SWEEP_CONCURRENCY }))
    .toMatchObject({ fullSweepRequired: true, reason: 'image-changed' });
  const dirty = [identity('test/a.test.ts', ['src/a.ts'], true), rows[1]!];
  expect(planGateSweepAppend({ certificate, current: dirty, interference: {}, now: 1_050, sweepConcurrency: FIXTURE_SWEEP_CONCURRENCY }))
    .toMatchObject({ fullSweepRequired: true, reason: 'dirty-ratio-exceeded' });
  expect(planGateSweepAppend({ certificate, current: rows, interference: {}, now: 1_101, sweepConcurrency: FIXTURE_SWEEP_CONCURRENCY }))
    .toMatchObject({ fullSweepRequired: true, reason: 'certificate-too-old' });
  expect(() => planGateSweepAppend({ certificate, current: rows, interference: {}, now: 1_050,
    sweepConcurrency: FIXTURE_SWEEP_CONCURRENCY + FIXTURE_SWEEP_CONCURRENCY })).toThrow('sweep concurrency does not match certificate');
  expect(planGateSweepAppend({ certificate: { ...certificate, maxDirtyRatio: FIXTURE_DELETION_DIRTY_RATIO }, current: [rows[1]!],
    interference: { 'test/a.test.ts': ['test/b.test.ts'] }, now: 1_050, sweepConcurrency: FIXTURE_SWEEP_CONCURRENCY }))
    .toMatchObject({ dirtyFiles: [], removedFiles: ['test/a.test.ts'], supplementalFiles: ['test/b.test.ts'], fullSweepRequired: false });
  const unmeasurable = { ...rows[0]!, contentHashes: {} };
  expect(planGateSweepAppend({ certificate, current: [unmeasurable, rows[1]!], interference: {}, now: 1_050, sweepConcurrency: FIXTURE_SWEEP_CONCURRENCY }))
    .toMatchObject({ dirtyFiles: ['test/a.test.ts'], removedFiles: [], supplementalFiles: ['test/a.test.ts', 'test/b.test.ts'], fullSweepRequired: true, reason: 'dirty-ratio-exceeded' });
});

test('whole-sweep age refresh requires a full sweep and incomplete or mismatched runs cannot mint receipts', () => {
  const rows = [identity('test/a.test.ts', ['src/a.ts']), identity('test/b.test.ts', ['src/b.ts'])];
  const baselineReceipts = rows.map(priorReceipt);
  const fullSweep = simGateReceiptFileClosureCas({ sourceRunId: 'c159bb8d', trainHead40: TRAIN, cutHead40: CUT, imageDigest: IMAGE,
    prior: rows, priorReceipts: baselineReceipts, appended: rows.map((row) => identity(row.file, row.closureFiles.filter((file) => file !== row.file), true)),
    isolated: [], runSupplemental });
  expect(fullSweep.appendInvalidation).toMatchObject({ fullSweepRequired: true, reason: 'dirty-ratio-exceeded' });
  expect(fullSweep.refreshedSweepCertificate?.measuredAt).toBe(3_000);
  const wrongConcurrency = simGateReceiptFileClosureCas({ sourceRunId: '1475eed8', trainHead40: TRAIN, cutHead40: CUT, imageDigest: IMAGE,
    prior: [rows[0]!], priorReceipts: [baselineReceipts[0]!], appended: [identity(rows[0]!.file, ['src/a.ts'], true)], isolated: [],
    runSupplemental: (input) => ({ aggregate: 'complete', gateOutcome: 'pass', publishDecision: 'eligible',
      executedConcurrency: input.concurrency + FIXTURE_CONCURRENCY_DRIFT, plan: { fullSweep: false, rerunShardIds: [] } }) });
  expect(wrongConcurrency.certificateRefreshBlocked).toBe(true);
  expect(wrongConcurrency.refreshedSweepCertificate).toBeUndefined();
  expect(wrongConcurrency.measuredAfterAppend).toEqual([]);
  const incompleteRun = simGateReceiptFileClosureCas({ sourceRunId: '1475eed8', trainHead40: TRAIN, cutHead40: CUT, imageDigest: IMAGE,
    prior: [rows[0]!], priorReceipts: [baselineReceipts[0]!], appended: [identity(rows[0]!.file, ['src/a.ts'], true)], isolated: [],
    runSupplemental: (input) => ({ aggregate: 'incomplete', gateOutcome: 'pass', publishDecision: 'eligible',
      executedConcurrency: input.concurrency, plan: { fullSweep: false, rerunShardIds: [] } }) });
  expect(incompleteRun.supplementalGate).toMatchObject({ gateOutcome: 'unmeasured', publishDecision: 'blocked' });
  expect(incompleteRun.measuredAfterAppend).toEqual([]);
  expect(incompleteRun.cutPlan.measure).toHaveLength(1);
  expect(incompleteRun.refreshedSweepCertificate).toBeUndefined();
});

test('file receipt identity fails closed for incomplete closure hashes or a different pinned image', () => {
  const row = identity('test/one.test.ts', ['src/one.ts']);
  const incomplete = { ...row, contentHashes: { 'test/one.test.ts': row.contentHashes['test/one.test.ts']! } };
  const otherImage = { ...row, imageDigest: 'sha256:' + 'b'.repeat(64) };
  const receipts = [priorReceipt(row)];
  expect(simGateReceiptFileClosureCas({ sourceRunId: '1475eed8', trainHead40: TRAIN, cutHead40: CUT, imageDigest: IMAGE, prior: [row], priorReceipts: receipts,
    appended: [incomplete, otherImage], isolated: [], runSupplemental }).appendPlan.measure).toHaveLength(2);
});

test('sweep certificate refuses a valid receipt measured on an unrelated head', () => {
  const row = identity('test/head.test.ts', ['src/head.ts']);
  expect(() => buildGateSweepCertificate({ sourceHead40: CUT, imageDigest: IMAGE, identities: [row], receipts: [priorReceipt(row)],
    measuredAt: 1_000, sweepConcurrency: FIXTURE_EXECUTOR_CONCURRENCY, maxAgeMs: FIXTURE_SWEEP_MAX_AGE_MS,
    maxDirtyRatio: FIXTURE_SWEEP_MAX_DIRTY_RATIO, thresholdSource: 'fixture: measured sweep policy' }))
    .toThrow('sweep certificate receipt head mismatch');
});

test('isolated file outcomes persist as checksummed content-addressed receipts', () => {
  const row = identity('test/isolated.test.ts', ['src/isolated.ts']);
  const measured = simGateReceiptFileClosureCas({ sourceRunId: '1475eed8', trainHead40: TRAIN, cutHead40: CUT, imageDigest: IMAGE,
    prior: [row], priorReceipts: [priorReceipt(row)], appended: [identity(row.file, ['src/isolated.ts'], true)], isolated: [row], runSupplemental }).measuredAfterAppend[0]!;
  const root = mkdtempSync(join(tmpdir(), 'gate-file-receipt-cas-'));
  try {
    const written = saveGateFileReceipt(root, measured);
    expect(readGateFileReceipt(root, measured.key)).toEqual(written);
    expect(readGateFileReceipt(root, 'f'.repeat(64))).toBeNull();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('closure identity includes non-code literal inputs and keeps existing failures attached to an owner', () => {
  const tree = { files: ['apps/pwa/check.test.ts', 'apps/pwa/config.json', 'apps/pwa/shared.ts'], preload: [],
    read: (file: string) => ({
      'apps/pwa/check.test.ts': "import config from './config.json'; import { value } from './shared.js'; test(config.name, () => value());",
      'apps/pwa/config.json': '{"name":"fixture"}', 'apps/pwa/shared.ts': 'export const value = () => 1;',
    } as Record<string, string>)[file] };
  const identity = gateFileReceiptIdentityFromClosure(tree, 'apps/pwa/check.test.ts', IMAGE)!;
  expect(identity.closureFiles).toContain('apps/pwa/config.json');
  const failed = { ...priorReceipt(identity), outcome: 'fail' as const, owner: 'PWA', failureIds: ['apps/pwa/check.test.ts > owned regression'] };
  expect(auditGateFileReceiptSet({ identities: [identity], receipts: [failed] }).ok).toBe(true);
  const ownerless = { ...failed, owner: undefined };
  expect(auditGateFileReceiptSet({ identities: [identity], receipts: [ownerless] })).toMatchObject({ ok: false, reason: 'unowned failure receipt for apps/pwa/check.test.ts' });
  expect(auditGateFileReceiptSet({ identities: [identity], receipts: [{ ...failed, sourceHead40: 'bad' }] }))
    .toMatchObject({ ok: false, reason: 'invalid receipt head for apps/pwa/check.test.ts' });
  expect(auditGateFileReceiptSet({ identities: [identity], receipts: [{ ...failed, outcome: 'unknown' as 'fail' }] }))
    .toMatchObject({ ok: false, reason: 'invalid receipt outcome or lane for apps/pwa/check.test.ts' });
  expect(auditGateFileReceiptSet({ identities: [identity], receipts: [{ ...failed, failureIds: [''] }] }))
    .toMatchObject({ ok: false, reason: 'unowned failure receipt for apps/pwa/check.test.ts' });
  expect(auditGateFileReceiptSet({ identities: [identity], receipts: [{ ...failed, failureIds: 'apps/pwa/check.test.ts > bad' as unknown as string[] }] }))
    .toMatchObject({ ok: false, reason: 'unowned failure receipt for apps/pwa/check.test.ts' });
  expect(auditGateFileReceiptSet({ identities: [identity], receipts: [{ ...failed, closureFiles: null as unknown as string[] }] }))
    .toMatchObject({ ok: false, reason: 'invalid receipt record' });
  expect(auditGateFileReceiptSet({ identities: [identity], receipts: [{ ...failed, owner: 42 as unknown as string }] }))
    .toMatchObject({ ok: false, reason: 'invalid receipt record' });
  expect(auditGateFileReceiptSet({ identities: [identity], receipts: [{ ...failed, carriedToHead40: [...TRAIN] as unknown as string }] }))
    .toMatchObject({ ok: false, reason: 'invalid receipt record' });
});

test('fixture-only changes invalidate exactly the importing test while opaque inputs always run with a receipt reason', () => {
  const files = ['apps/a.test.ts', 'apps/a.json', 'apps/b.test.ts', 'apps/b.json',
    'src/opaque.test.ts', 'src/opaque-reader.ts', 'fixtures/runtime-a.json'];
  const content: Record<string, string> = {
    'apps/a.test.ts': "import config from './a.json'; test(config.name, () => {});",
    'apps/a.json': '{"name":"a"}',
    'apps/b.test.ts': "import config from './b.json'; test(config.name, () => {});",
    'apps/b.json': '{"name":"b"}',
    'src/opaque.test.ts': "import { readRuntimeFixture } from './opaque-reader.js'; test('opaque fixture', () => readRuntimeFixture(process.env.FIXTURE));",
    'src/opaque-reader.ts': "import { readFileSync } from 'node:fs'; export const readRuntimeFixture = (path: string) => readFileSync(path, 'utf8');",
    'fixtures/runtime-a.json': '{"value":1}',
  };
  const tree = (snapshot: Readonly<Record<string, string>>): ClosureTree => ({ files, preload: [], read: (file) => snapshot[file] });
  const beforeTree = tree(content);
  const before = ['apps/a.test.ts', 'apps/b.test.ts'].map((file) => gateFileReceiptIdentityFromClosure(beforeTree, file, IMAGE)!);
  const receipts = before.map(priorReceipt);
  const nextContent = { ...content, 'apps/a.json': '{"name":"a changed"}' };
  const after = ['apps/a.test.ts', 'apps/b.test.ts'].map((file) => gateFileReceiptIdentityFromClosure(tree(nextContent), file, IMAGE)!);
  const plan = planGateFileReceipts({ current: after, receipts });
  expect(plan.measure.map((row) => row.file)).toEqual(['apps/a.test.ts']);
  expect(plan.reuse.map((row) => row.file)).toEqual(['apps/b.test.ts']);

  const opaque = gateFileReceiptIdentityFromClosure(beforeTree, 'src/opaque.test.ts', IMAGE)!;
  expect(opaque.opaqueReasons).toEqual(['src/opaque-reader.ts: reads a file through an opaque path']);
  const receiptRoot = mkdtempSync(join(tmpdir(), 'gate-opaque-receipt-'));
  try {
    expect(savePassingGateFileReceipts({ repo: '/fixture', root: receiptRoot, files: [opaque.file], commit: CUT,
      imageDigest: IMAGE, shardId: 'reused-pod', attempt: 1, host: 'sim-host', closureTree: beforeTree,
      runs: [{ rc: 0, pass: 1, fail: 0, errors: 0, passedIds: ['src/opaque.test.ts > opaque fixture'] }] })).toBe(0);
    const saved = savePassingGateFileReceipts({ repo: '/fixture', root: receiptRoot, files: [opaque.file], commit: CUT,
      imageDigest: IMAGE, shardId: 'sim-pod', attempt: 1, host: 'sim-host', graphRunId: 'opaque-measurement-run',
      closureTree: beforeTree, runs: [{ rc: 0, pass: 1, fail: 0, errors: 0, passedIds: ['src/opaque.test.ts > opaque fixture'] }] });
    expect(saved).toBe(1);
    const opaqueKey = gateFileReceiptKey(opaque)!;
    const persisted = readGateFileReceipt(receiptRoot, opaqueKey)!;
    expect(persisted.opaqueReasons).toEqual(['src/opaque-reader.ts: reads a file through an opaque path']);
    expect(persisted.evidence).toMatchObject({ runId: 'opaque-measurement-run' });
    expect(planGateFileReceipts({ current: [opaque], receipts: [persisted] })).toMatchObject({ reuse: [], measure: [opaque] });
  } finally { rmSync(receiptRoot, { recursive: true, force: true }); }
  expect(testsReachingChanged(beforeTree, ['fixtures/runtime-a.json'], ['src/opaque.test.ts']))
    .toMatchObject({ ok: true, tests: ['src/opaque.test.ts'] });
});

test('duplicate file receipts are measured again and fail the exact-inventory audit', () => {
  const row = identity('test/duplicate.test.ts', ['src/duplicate.ts']);
  const duplicate = priorReceipt(row);
  expect(planGateFileReceipts({ current: [row], receipts: [duplicate, { ...duplicate }] }))
    .toMatchObject({ reuse: [], measure: [row] });
  expect(planGateFileReceipts({ current: [row], receipts: [duplicate, { ...duplicate, closureFiles: ['test/duplicate.test.ts'] }] }))
    .toMatchObject({ reuse: [], measure: [row] });
  expect(planGateFileReceipts({ current: [row], receipts: [duplicate, { ...duplicate, file: 'test/extra.test.ts' }] }))
    .toMatchObject({ reuse: [], measure: [row] });
  expect(planGateFileReceipts({ current: [row], receipts: [duplicate, null as unknown as GateFileReceipt] }))
    .toMatchObject({ reuse: [], measure: [row] });
  expect(planGateFileReceipts({ current: [row], receipts: [{ ...duplicate, carriedToHead40: [...TRAIN] as unknown as string }] }))
    .toMatchObject({ reuse: [], measure: [row] });
  expect(planGateFileReceipts({ current: [row, row], receipts: [duplicate] }))
    .toMatchObject({ reuse: [], measure: [row, row] });
  expect(planGateFileReceipts({ current: [row], receipts: [{ ...duplicate, closureFiles: ['test/duplicate.test.ts'] }] }))
    .toMatchObject({ reuse: [], measure: [row] });
  expect(auditGateFileReceiptSet({ identities: [row], receipts: [duplicate, { ...duplicate }] }))
    .toMatchObject({ ok: false, reason: 'receipt inventory mismatch' });
  expect(auditGateFileReceiptSet({ identities: [row, row], receipts: [duplicate] }))
    .toMatchObject({ ok: false, reason: 'duplicate expected file' });
  expect(auditGateFileReceiptSet({ identities: [row], receipts: [] }))
    .toMatchObject({ ok: false, reason: 'receipt inventory mismatch' });
  expect(auditGateFileReceiptSet({ identities: [row], receipts: [{ ...duplicate, key: 'f'.repeat(64) }] }))
    .toMatchObject({ ok: false, reason: 'receipt identity mismatch for test/duplicate.test.ts' });
});

test('a failed result and a passing isolated recheck retain both measurements for the same file key', () => {
  const row = identity('test/flaky.test.ts', ['src/flaky.ts']);
  const base = priorReceipt(row);
  const root = mkdtempSync(join(tmpdir(), 'gate-file-receipt-recheck-'));
  try {
    const failed = { ...base, outcome: 'fail' as const, owner: 'NT-3', failureIds: ['test/flaky.test.ts > intermittent'] };
    saveGateFileReceipt(root, failed);
    const passed = { ...base, lane: 'isolated-recheck' as const, evidence: { file: row.file, pass: 1, fail: 0, sourceRunId: 'recheck' } };
    saveGateFileReceipt(root, passed);
    saveGateFileReceipt(root, passed);
    expect(readGateFileReceipt(root, base.key)?.outcome).toBe('pass');
    expect(readGateFileReceiptHistory(root, base.key).map((receipt) => receipt.outcome).sort()).toEqual(['fail', 'pass']);
    const malformedCurrent = { ...passed, carriedToHead40: 'bad' };
    writeFileSync(join(root, 'files', `${base.key}.json`), JSON.stringify({ ...malformedCurrent,
      recordSha256: hash(JSON.stringify(malformedCurrent)) }) + '\n');
    expect(readGateFileReceipt(root, base.key)).toBeNull();
    writeFileSync(join(root, 'files', `${base.key}.json`), '{}\n');
    expect(readGateFileReceipt(root, base.key)).toBeNull();
    expect(readGateFileReceiptHistory(root, base.key).map((receipt) => receipt.outcome)).toEqual(['fail']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('failed or unmeasured supplemental gate does not refresh the sweep certificate', () => {
  const row = identity('test/dirty.test.ts', ['src/dirty.ts']);
  const prior = identity('test/stable.test.ts', ['src/stable.ts']);
  const result = simGateReceiptFileClosureCas({ sourceRunId: 'c159bb8d', trainHead40: TRAIN, cutHead40: CUT, imageDigest: IMAGE,
    prior: [row], priorReceipts: [priorReceipt(row)], appended: [{ ...row, contentHashes: { ...row.contentHashes, 'src/dirty.ts': hash('changed') } }],
    isolated: [], supplementalOutcome: 'fail', runSupplemental });
  expect(result.supplementalGate).toMatchObject({ gateOutcome: 'fail', publishDecision: 'blocked' });
  expect(result.certificateRefreshBlocked).toBe(true);
  expect(result.refreshedSweepCertificate).toBeUndefined();
  expect(result.measuredAfterAppend).toEqual([]);
});
