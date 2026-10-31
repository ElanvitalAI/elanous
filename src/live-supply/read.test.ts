import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshSupplyAxis, loadLiveSupplySnapshot } from './read.js';
import { SUPPLY_AXES } from './snapshot.js';

test('atomic pointer reader rejects invalid and future samples before launch', () => {
  const directory = mkdtempSync(join(tmpdir(), 'live-supply-read-'));
  try {
    expect(loadLiveSupplySnapshot(directory)).toBeNull();
    writeFileSync(join(directory, 'latest.json'), '{bad');
    expect(loadLiveSupplySnapshot(directory)).toBeNull();
    const now = Date.parse('2026-10-26T12:00:00Z');
    const snapshot = {
      version: 1, sequence: 3, observedAt: '2026-10-26T11:59:00Z', expiresAt: '2026-10-26T12:01:00Z',
      sources: Object.fromEntries(SUPPLY_AXES.map(axis => [axis, {
        status: axis === 'pool' ? 'measured' : 'unknown',
        observedAt: axis === 'pool' ? '2026-10-26T12:02:00Z' : null, reason: null,
      }])),
      values: { pool: { members: [] } },
    };
    writeFileSync(join(directory, 'latest.json'), JSON.stringify(snapshot));
    expect(freshSupplyAxis(loadLiveSupplySnapshot(directory), 'pool', now)).toEqual({ status: 'unavailable', reason: 'unmeasured' });
    snapshot.sources.pool!.observedAt = '2026-10-26T11:59:00Z';
    writeFileSync(join(directory, 'latest.json'), JSON.stringify(snapshot));
    expect(freshSupplyAxis(loadLiveSupplySnapshot(directory), 'pool', now)).toMatchObject({ status: 'fresh', sequence: 3 });
    snapshot.sources.pool!.observedAt = '2026-10-26T11:55:00Z';
    writeFileSync(join(directory, 'latest.json'), JSON.stringify(snapshot));
    expect(freshSupplyAxis(loadLiveSupplySnapshot(directory), 'pool', now)).toEqual({ status: 'unavailable', reason: 'expired' });
    snapshot.sources.pool!.observedAt = { toString: 0, valueOf: 0 } as unknown as string;
    writeFileSync(join(directory, 'latest.json'), JSON.stringify(snapshot));
    const malformed = loadLiveSupplySnapshot(directory);
    expect(malformed).toBeNull();
    expect(freshSupplyAxis(malformed, 'pool', now)).toEqual({ status: 'unavailable', reason: 'missing' });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
