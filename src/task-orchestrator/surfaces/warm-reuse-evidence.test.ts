import { expect, spyOn, test } from 'bun:test';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decideWarmReuse } from './pod-warm-switch.js';
import { debug } from '../../debug/log.js';
import { loadWarmReuseEvidenceByConsumer, readWarmReuseEvidence, recordWarmReuseEvidence } from './warm-reuse-evidence.js';

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

test('actual journal rows supply measured TA evidence; missing rows stay unmeasured', () => {
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
        expectedLockHash: lock, workerLockHash: lock, leaseValid: true, canaryPassed: true, agree: true,
      });
    }
    const evidence = loadWarmReuseEvidenceByConsumer({ head, main }, path);
    expect(decideWarmReuse('ta', { gateRecheck: true, land: true, ta: true }, evidence))
      .toEqual({ consumer: 'ta', live: true, reason: 'live' });
    expect(observed).toEqual(['gate-recheck', 'land', 'ta'].map((consumer) => ({ consumer, measured: true })));

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
