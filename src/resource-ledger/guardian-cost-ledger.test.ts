import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guardianMonthlyCost, readResourceLedger, recordGuardianCostSnapshot,
  type GuardianCostSnapshot } from './resource-ledger.js';

test('Guardian monthly cost requires fresh provider reports and uses the latest per provider', () => {
  const root = mkdtempSync(join(tmpdir(), 'guardian-cost-'));
  const path = join(root, 'events.jsonl');
  const now = new Date('2026-11-11T00:00:00.000Z');
  const aws: GuardianCostSnapshot = { measurementId: 'aws-1', provider: 'aws', month: '2026-11',
    spentKrw: 2000, measuredAt: '2026-11-10T23:00:00.000Z', evidenceRef: 'billing/aws/2026-11/1' };
  try {
    expect(guardianMonthlyCost([], '2026-11', ['aws', 'gcp'], now))
      .toMatchObject({ status: 'unknown', totalKrw: null, missingProviders: ['aws', 'gcp'] });
    recordGuardianCostSnapshot(aws, now, path);
    recordGuardianCostSnapshot(aws, now, path);
    expect(readResourceLedger(path)).toHaveLength(1);
    recordGuardianCostSnapshot({ ...aws, measurementId: 'gcp-1', provider: 'gcp', spentKrw: 3000 }, now, path);
    expect(guardianMonthlyCost(readResourceLedger(path), '2026-11', ['aws', 'gcp'], now))
      .toMatchObject({ status: 'measured', totalKrw: 5000 });
    recordGuardianCostSnapshot({ ...aws, measurementId: 'aws-2', spentKrw: 2500,
      measuredAt: '2026-11-10T23:30:00.000Z' }, now, path);
    expect(guardianMonthlyCost(readResourceLedger(path), '2026-11', ['aws', 'gcp'], now).totalKrw).toBe(5500);
    expect(guardianMonthlyCost(readResourceLedger(path), '2026-11', ['aws', 'gcp'],
      new Date('2026-11-13T00:00:00.000Z'))).toMatchObject({ status: 'unknown', totalKrw: null,
      staleProviders: ['aws', 'gcp'] });
    expect(() => recordGuardianCostSnapshot({ ...aws, spentKrw: 9999 }, now, path)).toThrow('ID conflict');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Guardian cost writer refuses unsupported month and future or untraceable reports', () => {
  const root = mkdtempSync(join(tmpdir(), 'guardian-cost-'));
  const path = join(root, 'events.jsonl');
  const now = new Date('2026-11-11T00:00:00.000Z');
  const base: GuardianCostSnapshot = { measurementId: 'aws-1', provider: 'aws', month: '2026-11',
    spentKrw: 1, measuredAt: '2026-11-10T23:00:00.000Z', evidenceRef: 'billing/aws/1' };
  try {
    expect(() => recordGuardianCostSnapshot({ ...base, month: '2026-13' }, now, path)).toThrow('invalid');
    expect(() => recordGuardianCostSnapshot({ ...base, measuredAt: '2026-11-12T00:00:00.000Z' }, now, path)).toThrow('invalid');
    expect(() => recordGuardianCostSnapshot({ ...base, evidenceRef: '' }, now, path)).toThrow('invalid');
    expect(() => recordGuardianCostSnapshot({ ...base, month: '2027-01' }, now, path)).toThrow('invalid');
    expect(() => recordGuardianCostSnapshot({ ...base, measurementId: 1 as unknown as string }, now, path)).toThrow('invalid');
    expect(() => recordGuardianCostSnapshot({ ...base, provider: 1 as unknown as string }, now, path)).toThrow('invalid');
    expect(readResourceLedger(path)).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Guardian monthly query rejects malformed caller events and persisted snapshots', () => {
  const root = mkdtempSync(join(tmpdir(), 'guardian-cost-invalid-'));
  const path = join(root, 'events.jsonl');
  const now = new Date('2026-11-11T00:00:00.000Z');
  const base: GuardianCostSnapshot = { measurementId: 'aws-1', provider: 'aws', month: '2026-11',
    spentKrw: 1, measuredAt: '2026-11-10T23:00:00.000Z', evidenceRef: 'billing/aws/1' };
  const malformed = [
    { ...base, spentKrw: -1 },
    { ...base, evidenceRef: '' },
    { ...base, measuredAt: 'not-a-date' },
    { ...base, month: '2026-12' },
  ];
  try {
    for (const snapshot of malformed) {
      const event = { event: 'guardian-cost-snapshot' as const, at: now.toISOString(), snapshot };
      expect(() => guardianMonthlyCost([event], '2026-11', ['aws'], now)).toThrow('invalid');
      writeFileSync(path, JSON.stringify(event) + '\n');
      expect(() => readResourceLedger(path)).toThrow('invalid');
    }
    for (const snapshot of [{ ...base, measurementId: 1 }, { ...base, provider: 1 }]) {
      writeFileSync(path, JSON.stringify({ event: 'guardian-cost-snapshot', at: now.toISOString(), snapshot }) + '\n');
      expect(() => readResourceLedger(path)).toThrow('invalid');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Guardian monthly query rejects measurement ID conflicts and picks timestamp ties deterministically', () => {
  const now = new Date('2026-11-11T00:00:00.000Z');
  const base: GuardianCostSnapshot = { measurementId: 'aws-a', provider: 'aws', month: '2026-11',
    spentKrw: 100, measuredAt: '2026-11-10T23:00:00.000Z', evidenceRef: 'billing/aws/a' };
  const first = { event: 'guardian-cost-snapshot' as const, at: now.toISOString(), snapshot: base };
  const conflict = { event: 'guardian-cost-snapshot' as const, at: now.toISOString(),
    snapshot: { ...base, spentKrw: 999 } };
  expect(() => guardianMonthlyCost([first, conflict], '2026-11', ['aws'], now)).toThrow('ID conflict');
  expect(() => guardianMonthlyCost([conflict, first], '2026-11', ['aws'], now)).toThrow('ID conflict');
  const tied = { event: 'guardian-cost-snapshot' as const, at: now.toISOString(),
    snapshot: { ...base, measurementId: 'aws-z', spentKrw: 200, evidenceRef: 'billing/aws/z' } };
  expect(guardianMonthlyCost([first, tied], '2026-11', ['aws'], now).totalKrw).toBe(200);
  expect(guardianMonthlyCost([tied, first], '2026-11', ['aws'], now).totalKrw).toBe(200);
});
