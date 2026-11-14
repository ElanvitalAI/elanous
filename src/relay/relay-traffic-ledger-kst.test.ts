import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRelayTrafficLedger } from './relay-traffic-ledger.js';

test('real ledger assigns boundary minutes to KST months across November, December and year rollover', () => {
  const root = mkdtempSync(join(tmpdir(), 'relay-kst-month-'));
  const store = createRelayTrafficLedger(join(root, 'relay', 'usage.sqlite'), root);
  try {
    for (const year of [1988, 2019]) {
      expect(() => store.monthUsage('synthetic-a', year, 6)).toThrow('invalid relay traffic month');
    }
    expect(store.monthUsage('synthetic-a', 2020, 1)).toEqual({
      minute: Date.parse('2020-01-01T00:00:00+09:00') / 60_000, ingressBytes: 0, egressBytes: 0,
    });
    const events = [
      ['2026-10-31T23:59:00+09:00', 2],
      ['2026-11-01T00:00:00+09:00', 3],
      ['2026-11-01T00:01:00+09:00', 5],
      ['2026-12-01T00:00:00+09:00', 7],
      ['2027-01-01T00:00:00+09:00', 11],
    ] as const;
    for (const [at, bytes] of events) expect(store.charge({
      memberId: 'synthetic-a', connectionId: 'synthetic', minute: Date.parse(at) / 60_000,
      direction: 'ingress', bytes,
    }).status).toBe('allowed');
    expect(store.charge({ memberId: 'synthetic-b', connectionId: 'synthetic',
      minute: Date.parse('2026-11-01T00:00:00+09:00') / 60_000, direction: 'egress', bytes: 13 }).status).toBe('allowed');
    expect(store.monthUsage('synthetic-a', 2026, 10).ingressBytes).toBe(2);
    expect(store.monthUsage('synthetic-a', 2026, 11)).toEqual({
      minute: Date.parse('2026-11-01T00:00:00+09:00') / 60_000, ingressBytes: 8, egressBytes: 0,
    });
    expect(store.monthUsage('synthetic-a', 2026, 12).ingressBytes).toBe(7);
    expect(store.monthUsage('synthetic-a', 2027, 1).ingressBytes).toBe(11);
    expect(store.monthUsage('synthetic-b', 2026, 11).egressBytes).toBe(13);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
