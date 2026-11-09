import { expect, spyOn, test } from 'bun:test';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decideWarmReuse } from './pod-warm-switch.js';
import { debug } from '../../debug/log.js';
import { invalidateWarmReuseEvidence, loadWarmReuseEvidenceByConsumer, readWarmReuseEvidence, recordWarmGateEvidence, recordWarmReuseEvidence } from './warm-reuse-evidence.js';

const head = 'a'.repeat(40);
const main = 'b'.repeat(40);
const lock = 'c'.repeat(64);

test('land evidence persists only real lease identity and reads the exact head/main window', () => {
  const root = mkdtempSync(join(tmpdir(), 'land-warm-evidence-'));
  const path = join(root, 'warm-reuse-evidence.jsonl');
  try {
    recordWarmReuseEvidence(path, {
      schema: 1, consumer: 'land', pr: 21, head, main, recordedAt: new Date().toISOString(),
      workerId: 'worker-1', leaseId: 'lease-real-1', generation: 7, expectedLockHash: lock, workerLockHash: lock,
      leaseValid: true, canaryPassed: true, agree: true,
    });
    recordWarmReuseEvidence(path, {
      schema: 1, consumer: 'ta', pr: 22, head, main, recordedAt: new Date().toISOString(),
      reason: 'cold-fallback',
    });
    const lines = readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(lines[0]).toMatchObject({ leaseId: 'lease-real-1', generation: 7, expectedLockHash: lock, workerLockHash: lock });
    expect(lines[1]).not.toHaveProperty('leaseId');
    expect(readWarmReuseEvidence(path, { consumer: 'land', pr: 21, head, main })).toEqual([expect.objectContaining({
      leaseId: 'lease-real-1', generation: 7, expectedLockHash: lock, workerLockHash: lock,
      leaseValid: true, canaryPassed: true, agree: true,
    })]);
    expect(readWarmReuseEvidence(path, { consumer: 'ta', pr: 22, head, main })).toHaveLength(1);
    expect(readWarmReuseEvidence(path, { consumer: 'land', pr: 21, head, main: 'e'.repeat(40) })).toBeUndefined();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('missing warm identity cannot be written as a green sample', () => {
  const root = mkdtempSync(join(tmpdir(), 'land-warm-evidence-'));
  const path = join(root, 'warm-reuse-evidence.jsonl');
  try {
    recordWarmReuseEvidence(path, {
      schema: 1, consumer: 'land', pr: 21, head, main, recordedAt: new Date().toISOString(),
      workerId: 'worker-1', leaseId: 'lease-without-generation', expectedLockHash: lock, workerLockHash: lock,
      leaseValid: true, canaryPassed: true, agree: true,
    });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ reason: 'warm-lease-unmeasured' });
    const unmeasured = readWarmReuseEvidence(path, { consumer: 'land', pr: 21, head, main });
    expect(unmeasured).toHaveLength(1);
    expect(unmeasured?.[0]).toMatchObject({ reason: 'warm-lease-unmeasured' });
    expect(unmeasured?.[0]).not.toHaveProperty('leaseId');
    expect(unmeasured?.[0]).not.toHaveProperty('generation');
    expect(unmeasured?.[0]).not.toHaveProperty('expectedLockHash');
    expect(unmeasured?.[0]).not.toHaveProperty('workerLockHash');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('expired or corrupt rows cannot revive older warm matches', () => {
  const root = mkdtempSync(join(tmpdir(), 'warm-reuse-evidence-'));
  const path = join(root, 'warm-reuse-evidence.jsonl');
  try {
    recordWarmReuseEvidence(path, { schema: 1, consumer: 'gate-recheck', head, main,
      recordedAt: new Date(0).toISOString(), workerId: 'worker-1', leaseId: 'old-lease', generation: 1,
      expectedLockHash: lock, workerLockHash: lock, leaseValid: true, canaryPassed: true, agree: true });
    expect(readWarmReuseEvidence(path, { consumer: 'gate-recheck', head, main })).toBeUndefined();
    appendFileSync(path, '{broken-json}\n');
    expect(readWarmReuseEvidence(path, { consumer: 'gate-recheck', head, main })).toBeUndefined();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('corruption after recent passing rows invalidates the entire evidence window', () => {
  const root = mkdtempSync(join(tmpdir(), 'warm-reuse-evidence-'));
  const path = join(root, 'warm-reuse-evidence.jsonl');
  try {
    for (let i = 0; i < 3; i++) recordWarmReuseEvidence(path, {
      schema: 1, consumer: 'gate-recheck', head, main, recordedAt: new Date().toISOString(),
      workerId: 'worker-1', leaseId: `lease-${i}`, generation: i + 1,
      expectedLockHash: lock, workerLockHash: lock, leaseValid: true, canaryPassed: true, agree: true,
    });
    appendFileSync(path, '{broken-json}\n');
    expect(readWarmReuseEvidence(path, { consumer: 'gate-recheck', head, main })).toBeUndefined();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('unpaired TA observations stay unmeasured; missing rows stay unmeasured', () => {
  const root = mkdtempSync(join(tmpdir(), 'warm-reuse-evidence-supply-'));
  const path = join(root, 'warm-reuse-evidence.jsonl');
  const head = 'a'.repeat(40);
  const main = 'b'.repeat(40);
  const observed: Array<{ consumer: unknown; measured: unknown }> = [];
  const spy = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data: Record<string, unknown>) => {
    if (category === 'pod.warm' && event === 'evidence-supplied') observed.push({ consumer: data.consumer, measured: data.measured });
  }) as typeof debug.log);
  try {
    const now = Date.now();
    for (const consumer of ['gate-recheck', 'land', 'ta'] as const) {
      for (let index = 0; index < 3; index++) recordWarmReuseEvidence(path, {
        schema: 1, consumer, head, main, recordedAt: new Date(now - index).toISOString(),
        leaseId: `${consumer}-lease-${index}`, workerId: 'worker-live', generation: index + 1,
        expectedLockHash: lock, workerLockHash: lock, leaseValid: true,
        canaryPassed: consumer !== 'ta', agree: consumer !== 'ta',
        ...(consumer === 'ta' ? { comparisonMeasured: false, reason: 'ta-fresh-reference-unavailable' } : {}),
      });
    }
    const evidence = loadWarmReuseEvidenceByConsumer({ head, main }, path);
    expect(decideWarmReuse('ta', { gateRecheck: true, land: true, ta: true }, evidence))
      .toEqual({ consumer: 'ta', live: false, reason: 'canary-failed' });
    expect(observed).toEqual([
      { consumer: 'gate-recheck', measured: true }, { consumer: 'land', measured: true }, { consumer: 'ta', measured: false },
    ]);

    observed.length = 0;
    const missing = loadWarmReuseEvidenceByConsumer({ head: 'c'.repeat(40), main }, path);
    expect(decideWarmReuse('ta', { gateRecheck: true, land: true, ta: true }, missing))
      .toEqual({ consumer: 'ta', live: false, reason: 'predecessor-off:land' });
    expect(observed).toEqual(['gate-recheck', 'land', 'ta'].map((consumer) => ({ consumer, measured: false })));

    for (let index = 0; index < 3; index++) recordWarmReuseEvidence(path, {
      schema: 1, consumer: 'gate-recheck', head: 'd'.repeat(40), main, recordedAt: new Date(now - 10 + index).toISOString(),
      leaseId: `lease-${index}`, workerId: index < 2 ? 'worker-one' : 'worker-two', generation: index + 1,
      expectedLockHash: lock, workerLockHash: lock, leaseValid: true, canaryPassed: true, agree: true,
    });
    const changedWorker = loadWarmReuseEvidenceByConsumer({ head: 'd'.repeat(40), main }, path);
    expect(changedWorker?.['gate-recheck']?.consecutiveMatchSamples).toBe(1);
  } finally { spy.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});


test('unmeasured gate sample supersedes prior success; mismatched head and main are fail-closed', () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-warm-evidence-'));
  const path = join(root, 'warm-reuse-evidence.jsonl');
  try {
    const lease = { workerId: 'worker-1', leaseId: 'lease-1', generation: 1, expectedLockHash: lock,
      workerLockHash: lock, leaseValid: true, canaryPassed: true, agree: true };
    recordWarmGateEvidence({ head, main: head, evidence: lease }, path);
    recordWarmGateEvidence({ head, main: head, reason: 'decision-unavailable' }, path);
    const afterUnmeasured = loadWarmReuseEvidenceByConsumer({ head, main: head }, path);
    expect(afterUnmeasured?.['gate-recheck']).toMatchObject({ consecutiveMatchSamples: 0 });
    recordWarmGateEvidence({ head, main: 'd'.repeat(40), evidence: lease }, path);
    expect(readWarmReuseEvidence(path, { consumer: 'gate-recheck', head, main: 'd'.repeat(40) })?.at(-1))
      .toMatchObject({ leaseValid: false, canaryPassed: false, agree: false });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('failed gate evidence append removes prior success', () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-warm-evidence-fail-'));
  const path = join(root, 'warm-reuse-evidence.jsonl');
  try {
    recordWarmGateEvidence({ head, main: head, evidence: { workerId: 'worker-1', leaseId: 'lease-1', generation: 1,
      expectedLockHash: lock, workerLockHash: lock, leaseValid: true, canaryPassed: true, agree: true } }, path);
    expect(() => recordWarmGateEvidence({ head, main: head, reason: 'unmeasured' }, path,
      () => { throw new Error('disk full'); })).toThrow('disk full');
    expect(readWarmReuseEvidence(path, { consumer: 'gate-recheck', head, main: head })).toBeUndefined();
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('gate invalidation preserves independent land and TA evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-warm-invalidate-'));
  const path = join(root, 'warm-reuse-evidence.jsonl');
  try {
    recordWarmReuseEvidence(path, { schema: 1, consumer: 'gate-recheck', head, main: head,
      recordedAt: new Date().toISOString(), workerId: 'worker-g', leaseId: 'gate-lease', generation: 1,
      expectedLockHash: lock, workerLockHash: lock, leaseValid: true, canaryPassed: true, agree: true });
    recordWarmReuseEvidence(path, { schema: 1, consumer: 'land', pr: 21, head, main,
      recordedAt: new Date().toISOString(), workerId: 'worker-l', leaseId: 'land-lease', generation: 1,
      expectedLockHash: lock, workerLockHash: lock, leaseValid: true, canaryPassed: true, agree: true });
    recordWarmReuseEvidence(path, { schema: 1, consumer: 'ta', pr: 22, head, main,
      recordedAt: new Date().toISOString(), reason: 'cold-fallback' });
    invalidateWarmReuseEvidence(path);
    expect(readWarmReuseEvidence(path, { consumer: 'gate-recheck', head, main: head })).toBeUndefined();
    expect(readWarmReuseEvidence(path, { consumer: 'land', pr: 21, head, main })).toHaveLength(1);
    expect(readWarmReuseEvidence(path, { consumer: 'ta', pr: 22, head, main })).toHaveLength(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('gate invalidation lock inspection failure times out instead of spinning forever', () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-warm-lock-timeout-'));
  const path = join(root, 'warm-reuse-evidence.jsonl');
  try {
    writeFileSync(path, '');
    symlinkSync(join(root, 'missing-lock-target'), `${path}.lock`);
    expect(() => invalidateWarmReuseEvidence(path, 20)).toThrow(/(?:timed out locking warm reuse evidence invalidation|unable to inspect warm reuse evidence lock before timeout)/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
