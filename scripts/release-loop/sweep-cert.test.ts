import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { calibrateSweepCertificate, createSweepCertificate, createSweepCertificateForRun, gateSweepFileKeys, isSweepCertificate, planSweep, readSweepCertificate, recordSweepCertificateForRun, writeSweepCertificate } from './sweep-cert.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const fileKeys = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, index) => [
  `test/suite-${index}.test.ts`, hash(`closure-${index}`),
]));
const imageDigest = `sha256:${'a'.repeat(64)}`;

function fixture(overrides: Partial<Parameters<typeof createSweepCertificate>[0]> = {}) {
  const baseline = fileKeys(4);
  return createSweepCertificate({
    sourceCommit: 'a'.repeat(40), imageDigest, expectedFiles: Object.keys(baseline), measuredFileKeys: baseline,
    requestedConcurrency: 8, observedConcurrency: 8, runSucceeded: true,
    // 출처: #35951 SWEEP-CERT-CORE test-only branch-probe sentinels, not production policy.
    measuredAt: 1_000,
    maxAgeMs: 60_000, // 출처: #35951 test-only stale-certificate boundary.
    maxDirtyRatio: 0.75, // 출처: #35951 test-only dirty-ratio boundary.
    thresholdSource: 'fixture: measured sweep policy',
    ...overrides,
  });
}

test('SWEEP-CERT-CORE: certificate binds commit S, pinned image, complete file keys, concurrency, and measured policy', () => {
  const certificate = fixture({ measuredFileKeys: Object.fromEntries(Object.entries(fileKeys(4)).reverse()) });
  expect(certificate).toMatchObject({ schema: 1, sourceCommit: 'a'.repeat(40), imageDigest, sweepConcurrency: 8,
    measuredAt: 1_000, maxAgeMs: 60_000, maxDirtyRatio: 0.75, thresholdSource: 'fixture: measured sweep policy' }); // 출처: #35951 test-only policy sentinels.
  expect(Object.keys(certificate.fileKeys)).toEqual(Object.keys(fileKeys(4)).sort());
  expect(isSweepCertificate(certificate)).toBe(true);
  expect(isSweepCertificate({ ...certificate, imageDigest: `sha256:${'b'.repeat(64)}` })).toBe(false);
  expect(isSweepCertificate({ ...certificate, sourceCommit: 'b'.repeat(40) })).toBe(false);
  expect(isSweepCertificate({ ...certificate, fileKeys: { ...certificate.fileKeys, 'test/suite-0.test.ts': hash('tampered') } })).toBe(false);
});

test('SWEEP-CERT-CORE: three appended commits invalidate only dirty file keys and retain removed files as non-runnable', () => {
  const certificate = fixture({ maxDirtyRatio: 1 }); // 출처: #35951 test-only sentinel selects the full-vs-incremental boundary.
  const current: Record<string, string> = { ...fileKeys(4), 'test/new-contract.test.ts': hash('new closure') };
  current['test/suite-1.test.ts'] = hash('changed shared import');
  delete current['test/suite-3.test.ts'];
  const plan = planSweep({ certificate, currentCommit: 'b'.repeat(40), imageDigest,
    currentFileKeys: current, changedFiles: ['test/suite-0.test.ts', 'test/suite-1.test.ts'],
    sweepConcurrency: certificate.sweepConcurrency, now: certificate.measuredAt + 1_000 });
  expect(plan).toEqual({ mode: 'incremental', dirtyFiles: ['test/new-contract.test.ts', 'test/suite-0.test.ts', 'test/suite-1.test.ts'],
    removedFiles: ['test/suite-3.test.ts'], dirtyRatio: 1 });
});

test('SWEEP-CERT-CORE: image change, measured age, dirty ratio, and concurrency drift fail closed', () => {
  // 출처: #35951 SWEEP-CERT-CORE branch-probe sentinel for dirty-ratio fallback.
  const certificate = fixture({ maxDirtyRatio: 0.25 });
  const common = { certificate, currentCommit: 'b'.repeat(40), currentFileKeys: fileKeys(4),
    changedFiles: [], sweepConcurrency: certificate.sweepConcurrency, now: certificate.measuredAt + 1_000 };
  expect(planSweep({ ...common, imageDigest: `sha256:${'b'.repeat(64)}` })).toMatchObject({ mode: 'full', reason: 'image-changed' });
  expect(planSweep({ ...common, imageDigest, now: certificate.measuredAt + certificate.maxAgeMs! + 1 }))
    .toMatchObject({ mode: 'full', reason: 'certificate-stale' });
  expect(planSweep({ ...common, imageDigest, changedFiles: ['test/suite-0.test.ts', 'test/suite-1.test.ts'] }))
    .toMatchObject({ mode: 'full', reason: 'dirty-ratio', dirtyFiles: Object.keys(fileKeys(4)) });
  expect(planSweep({ ...common, imageDigest, sweepConcurrency: certificate.sweepConcurrency + 1 }))
    .toMatchObject({ mode: 'full', reason: 'concurrency-changed' });
});

test('SWEEP-CERT-CORE: certificate persists atomically and corrupted content fails closed', () => {
  const root = mkdtempSync(join(tmpdir(), 'sweep-cert-'));
  try {
    const certificate = fixture();
    const path = writeSweepCertificate(root, certificate);
    expect(readSweepCertificate(root)).toEqual(certificate);
    writeFileSync(path, readFileSync(path, 'utf8').replace(certificate.imageDigest, `sha256:${'b'.repeat(64)}`));
    expect(readSweepCertificate(root)).toBeNull();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('SWEEP-CERT-CORE simulation: only a complete passing full cut writes the sweep certificate', () => {
  const root = mkdtempSync(join(tmpdir(), 'sweep-cert-sim-'));
  const tree = { files: ['test/a.test.ts', 'test/b.test.ts'], preload: [], read: (path: string) => ({
    'test/a.test.ts': "test('a', () => {});", 'test/b.test.ts': "test('b', () => {});",
  } as Record<string, string>)[path] };
  const base = { root, fullSweep: true, sourceCommit: 'a'.repeat(40), imageDigest, tree,
    expectedFiles: ['test/a.test.ts', 'test/b.test.ts'], requestedConcurrency: 2, observedConcurrency: 2, measuredAt: 1_000 };
  try {
    expect(recordSweepCertificateForRun({ ...base, measuredFiles: [...base.expectedFiles], runSucceeded: true }).status).toBe('written');
    const certified = readSweepCertificate(root);
    expect(certified).toMatchObject({ sourceCommit: 'a'.repeat(40), imageDigest, sweepConcurrency: 2 });
    expect(recordSweepCertificateForRun({ ...base, measuredAt: 2_000, measuredFiles: ['test/a.test.ts'], runSucceeded: true }))
      .toEqual({ status: 'skipped', reason: 'measurement-incomplete' });
    expect(recordSweepCertificateForRun({ ...base, fullSweep: false, measuredAt: 3_000,
      measuredFiles: [...base.expectedFiles], runSucceeded: true })).toEqual({ status: 'skipped', reason: 'not-full-sweep' });
    expect(recordSweepCertificateForRun({ ...base, measuredAt: 4_000, measuredFiles: [...base.expectedFiles], runSucceeded: false }))
      .toEqual({ status: 'skipped', reason: 'measurement-incomplete' });
    expect(recordSweepCertificateForRun({ ...base, observedConcurrency: 1, measuredAt: 5_000,
      measuredFiles: [...base.expectedFiles], runSucceeded: true })).toEqual({ status: 'skipped', reason: 'measurement-incomplete' });
    expect(readSweepCertificate(root)).toEqual(certified);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('SWEEP-CERT-CORE: invalid keys and duplicate file paths are refused', () => {
  expect(() => fixture({ measuredFileKeys: { '../escape.test.ts': hash('a') } })).toThrow('invalid sweep certificate file key');
  expect(() => fixture({ measuredFileKeys: { './same.test.ts': hash('b') } })).toThrow('invalid sweep certificate file key');
});

test('SWEEP-CERT-CORE: magic prototype path is retained as an own file key', () => {
  const tree = { files: ['__proto__'], preload: [], read: (path: string) => path === '__proto__' ? "test('magic path', () => {});" : undefined };
  const keys = gateSweepFileKeys(tree, ['__proto__'], imageDigest);
  expect(Object.hasOwn(keys, '__proto__')).toBe(true);
  expect(keys['__proto__']).not.toBeNull();
  const certificate = createSweepCertificate({ sourceCommit: 'a'.repeat(40), imageDigest,
    expectedFiles: ['__proto__'], measuredFileKeys: keys, requestedConcurrency: 1, observedConcurrency: 1,
    measuredAt: 100, runSucceeded: true });
  expect(Object.hasOwn(certificate.fileKeys, '__proto__')).toBe(true);
  expect(isSweepCertificate(certificate)).toBe(true);
});

test('SWEEP-CERT-CORE: incomplete inventory and concurrency mismatch cannot mint a certificate', () => {
  expect(() => fixture({ expectedFiles: ['test/extra.test.ts'] })).toThrow('sweep measurement does not cover the complete test inventory');
  expect(() => fixture({ observedConcurrency: 7 })).toThrow('sweep concurrency does not match measurement');
});

test('SWEEP-CERT-CORE: closure keys change with a shared import and opaque closure stays dirty', () => {
  const tree = (shared: string, files = ['test/a.test.ts', 'test/b.test.ts', 'src/shared.ts']) => ({
    files, preload: [],
    read: (path: string) => ({
      'test/a.test.ts': "import { value } from '../src/shared.js'; test('a', () => value());",
      'test/b.test.ts': "import { value } from '../src/shared.js'; test('b', () => value());",
      'test/é.test.ts': "test('composed', () => {});",
      'test/e\u0301.test.ts': "test('decomposed', () => {});",
      'src/shared.ts': shared,
    } as Record<string, string>)[path],
  });
  const first = gateSweepFileKeys(tree('export const value = () => 1;'), ['test/a.test.ts', 'test/b.test.ts'], imageDigest);
  const changed = gateSweepFileKeys(tree('export const value = () => 2;'), ['test/a.test.ts', 'test/b.test.ts'], imageDigest);
  expect(first['test/a.test.ts']).not.toBeNull();
  expect(changed['test/a.test.ts']).not.toBe(first['test/a.test.ts']);
  expect(changed['test/b.test.ts']).not.toBe(first['test/b.test.ts']);

  const opaque = gateSweepFileKeys({ files: ['test/opaque.test.ts'], preload: [],
    read: () => "import { missing } from '../src/not-tracked.js'; test('opaque', () => missing());" },
  ['test/opaque.test.ts'], imageDigest);
  expect(opaque['test/opaque.test.ts']).toBeNull();
});

test('SWEEP-CERT-CORE: closure graph and content hashes share one snapshot when an import appears between phases', () => {
  const reads = new Map<string, number>();
  const tree = { files: ['test/drifting.test.ts', 'src/new-dependency.ts'], preload: [], read: (path: string) => {
    const count = (reads.get(path) ?? 0) + 1;
    reads.set(path, count);
    if (path === 'test/drifting.test.ts') return count === 1
      ? "test('before import', () => {});"
      : "import { value } from '../src/new-dependency.js'; test('after import', () => value());";
    if (path === 'src/new-dependency.ts') return 'export const value = () => 1;';
    return undefined;
  } };
  const keys = gateSweepFileKeys(tree, ['test/drifting.test.ts'], imageDigest);
  expect(keys['test/drifting.test.ts']).not.toBeNull();
  expect(reads.get('test/drifting.test.ts')).toBe(1);
  expect(reads.get('src/new-dependency.ts')).toBe(1);
});

test('SWEEP-CERT-CORE: null keys from untraceable closures remain dirty on every cut', () => {
  // 출처: #35951 SWEEP-CERT-CORE branch-probe sentinel; opaque keys must stay dirty.
  const cert = fixture({ expectedFiles: ['test/opaque.test.ts'], measuredFileKeys: { 'test/opaque.test.ts': null }, maxDirtyRatio: 1 });
  const plan = planSweep({ certificate: cert, currentCommit: 'b'.repeat(40), imageDigest,
    currentFileKeys: { 'test/opaque.test.ts': null }, changedFiles: [], sweepConcurrency: cert.sweepConcurrency, now: cert.measuredAt + 1 });
  expect(plan).toMatchObject({ mode: 'incremental', dirtyFiles: ['test/opaque.test.ts'], dirtyRatio: 1 });
});

test('SWEEP-CERT-CORE: first measured sweep can persist before thresholds are calibrated, but never enables incremental reuse', () => {
  const cert = fixture({ maxAgeMs: null, maxDirtyRatio: null, thresholdSource: null });
  expect(planSweep({ certificate: cert, currentCommit: 'b'.repeat(40), imageDigest,
    currentFileKeys: fileKeys(4), changedFiles: [], sweepConcurrency: cert.sweepConcurrency, now: cert.measuredAt + 1 }))
    .toMatchObject({ mode: 'full', reason: 'policy-unmeasured', dirtyFiles: Object.keys(fileKeys(4)) });
  // 출처: #35951 SWEEP-CERT-CORE branch-probe sentinel for calibrated-policy behavior.
  const calibrated = calibrateSweepCertificate(cert, { maxAgeMs: 30_000, maxDirtyRatio: 0.5, thresholdSource: 'fixture: measured sweep data' });
  expect(planSweep({ certificate: calibrated, currentCommit: 'b'.repeat(40), imageDigest,
    currentFileKeys: fileKeys(4), changedFiles: [], sweepConcurrency: cert.sweepConcurrency, now: cert.measuredAt + 1 }))
    .toMatchObject({ mode: 'incremental', dirtyFiles: [], dirtyRatio: 0 });
});

test('SWEEP-CERT-CORE: inventory membership ignores inherited object properties', () => {
  const baseline = fixture();
  const added = planSweep({ certificate: baseline, currentCommit: 'b'.repeat(40), imageDigest,
    currentFileKeys: Object.fromEntries([...Object.entries(baseline.fileKeys), ['constructor', hash('new')]]),
    changedFiles: [], sweepConcurrency: baseline.sweepConcurrency, now: baseline.measuredAt + 1 });
  expect(added).toMatchObject({ mode: 'incremental', dirtyFiles: ['constructor'] });

  // 출처: #35951 SWEEP-CERT-CORE branch-probe sentinel for the inherited-key removal case.
  const priorConstructor = fixture({ expectedFiles: ['constructor'], measuredFileKeys: { constructor: hash('old') } });
  const removed = planSweep({ certificate: priorConstructor, currentCommit: 'b'.repeat(40), imageDigest,
    currentFileKeys: {}, changedFiles: [], sweepConcurrency: priorConstructor.sweepConcurrency, now: priorConstructor.measuredAt + 1 });
  expect(removed).toMatchObject({ mode: 'full', reason: 'dirty-ratio', dirtyFiles: [], removedFiles: ['constructor'] });
});

test('SWEEP-CERT-CORE: only complete measured inventory at the requested concurrency mints the first certificate', () => {
  const tree = { files: ['test/a.test.ts', 'test/b.test.ts', 'test/é.test.ts', 'test/e\u0301.test.ts', 'src/shared.ts'], preload: [],
    read: (path: string) => ({
      'test/a.test.ts': "import { value } from '../src/shared.js'; test('a', () => value());",
      'test/b.test.ts': "import { value } from '../src/shared.js'; test('b', () => value());",
      'test/é.test.ts': "test('composed', () => {});",
      'test/e\u0301.test.ts': "test('decomposed', () => {});",
      'src/shared.ts': 'export const value = () => 1;',
    } as Record<string, string>)[path] };
  const certificate = createSweepCertificateForRun({ sourceCommit: 'a'.repeat(40), imageDigest, tree,
    expectedFiles: ['test/a.test.ts', 'test/b.test.ts'], measuredFiles: ['test/b.test.ts', 'test/a.test.ts'], runSucceeded: true,
    requestedConcurrency: 2, observedConcurrency: 2, measuredAt: 100 });
  expect(certificate).toMatchObject({ sourceCommit: 'a'.repeat(40), imageDigest, sweepConcurrency: 2,
    maxAgeMs: null, maxDirtyRatio: null, thresholdSource: null });
  expect(() => createSweepCertificate({ sourceCommit: certificate!.sourceCommit, imageDigest,
    expectedFiles: Object.keys(certificate!.fileKeys), measuredFileKeys: certificate!.fileKeys,
    requestedConcurrency: certificate!.sweepConcurrency, observedConcurrency: certificate!.sweepConcurrency,
    measuredAt: certificate!.measuredAt, runSucceeded: false })).toThrow('sweep run did not succeed');
  expect(Object.keys(certificate!.fileKeys)).toEqual(['test/a.test.ts', 'test/b.test.ts']);
  const unicodeRun = createSweepCertificateForRun({ sourceCommit: 'a'.repeat(40), imageDigest, tree,
    expectedFiles: ['test/é.test.ts', 'test/e\u0301.test.ts'], measuredFiles: ['test/e\u0301.test.ts', 'test/é.test.ts'],
    runSucceeded: true, requestedConcurrency: 2, observedConcurrency: 2, measuredAt: 100 });
  expect(Object.keys(unicodeRun!.fileKeys)).toEqual(['test/e\u0301.test.ts', 'test/é.test.ts']);
  expect(createSweepCertificateForRun({ sourceCommit: 'a'.repeat(40), imageDigest, tree,
    expectedFiles: ['test/a.test.ts', 'test/b.test.ts'], measuredFiles: ['test/a.test.ts'], runSucceeded: true,
    requestedConcurrency: 2, observedConcurrency: 2, measuredAt: 100 })).toBeNull();
  expect(createSweepCertificateForRun({ sourceCommit: 'a'.repeat(40), imageDigest, tree,
    expectedFiles: ['test/a.test.ts', 'test/b.test.ts'], measuredFiles: ['test/a.test.ts', 'test/b.test.ts'], runSucceeded: true,
    requestedConcurrency: 2, observedConcurrency: 1, measuredAt: 100 })).toBeNull();
  expect(createSweepCertificateForRun({ sourceCommit: 'a'.repeat(40), imageDigest, tree,
    expectedFiles: ['test/a.test.ts', 'test/b.test.ts'], measuredFiles: ['test/a.test.ts', 'test/b.test.ts'], runSucceeded: false,
    requestedConcurrency: 2, observedConcurrency: 2, measuredAt: 100 })).toBeNull();
  const mixedCase = createSweepCertificate({ sourceCommit: 'a'.repeat(40), imageDigest,
    expectedFiles: ['test/a.test.ts', 'test/Z.test.ts'], measuredFileKeys: { 'test/Z.test.ts': hash('Z'), 'test/a.test.ts': hash('a') },
    requestedConcurrency: 1, observedConcurrency: 1, measuredAt: 100, runSucceeded: true });
  expect(Object.keys(mixedCase.fileKeys)).toEqual(['test/Z.test.ts', 'test/a.test.ts']);
  const normalizedPaths = createSweepCertificate({ sourceCommit: 'a'.repeat(40), imageDigest,
    expectedFiles: ['test/é.test.ts', 'test/e\u0301.test.ts'],
    measuredFileKeys: { 'test/é.test.ts': hash('composed'), 'test/e\u0301.test.ts': hash('decomposed') },
    requestedConcurrency: 1, observedConcurrency: 1, measuredAt: 100, runSucceeded: true });
  expect(Object.keys(normalizedPaths.fileKeys)).toEqual(['test/e\u0301.test.ts', 'test/é.test.ts']);
  const integerPaths = createSweepCertificate({ sourceCommit: 'a'.repeat(40), imageDigest,
    expectedFiles: ['10', '2'], measuredFileKeys: { '10': hash('ten'), '2': hash('two') },
    requestedConcurrency: 1, observedConcurrency: 1, measuredAt: 100, runSucceeded: true });
  expect(Object.keys(integerPaths.fileKeys)).toEqual(['2', '10']);
  expect(isSweepCertificate(integerPaths)).toBe(true);
});
