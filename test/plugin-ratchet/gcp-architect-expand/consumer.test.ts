import { expect, test } from 'bun:test';
import { authorizeGcpFeature, authorizeSingleGcp } from '../../../src/ux-sim/gcp-architect-expand/consumer.js';
import { pressureFromExisting, readLocalPressure } from '../../../src/ux-sim/gcp-architect-expand/local-signals.js';

test('GCP consumer reads the grants table and fails closed for unknown membership or feature', () => {
  expect(authorizeSingleGcp({ currentTier: () => 'free' })).toEqual({ allowed: true, reason: 'granted' });
  expect(authorizeGcpFeature('architecture.multi_cloud', { currentTier: () => 'free' })).toEqual({ allowed: false, reason: 'denied' });
  expect(authorizeGcpFeature('architecture.multi_cloud', { currentTier: () => 'paid' })).toEqual({ allowed: true, reason: 'granted' });
  expect(authorizeGcpFeature('architecture.multi_cloud', { currentTier: () => null })).toEqual({ allowed: false, reason: 'missing-tier' });
  expect(authorizeGcpFeature('unlisted', { currentTier: () => 'paid' })).toEqual({ allowed: false, reason: 'unknown-feature' });
  expect(authorizeSingleGcp({ currentTier: () => 'free' }, '/missing/grants.json')).toEqual({ allowed: false, reason: 'invalid-table' });
});

test('existing host and queue readings project all four pressure axes without collecting', () => {
  const now = new Date('2026-11-10T04:00:00Z');
  const pressure = pressureFromExisting({ cores: 4, load1: 5, freeMemoryGiB: 2, freeTmpGiB: 3 },
    Array.from({ length: 11 }, () => ({ status: 'queued' as const })), now);
  expect([pressure.cpu.status, pressure.memory.status, pressure.disk.status, pressure.queue.status]).toEqual([
    'shortage', 'shortage', 'shortage', 'shortage']);
  expect(pressure.shortage).toBe(true);
  expect(pressure.observedAt).toBe(now.toISOString());
});

test('missing host or unreadable queue stays unknown instead of zero or sufficient', () => {
  const pressure = readLocalPressure({ host: () => { throw Error('offline'); }, queue: () => { throw Error('unreadable'); },
    now: () => new Date('2026-11-10T04:00:00Z') });
  expect([pressure.cpu.status, pressure.memory.status, pressure.disk.status, pressure.queue.status]).toEqual([
    'unknown', 'unknown', 'unknown', 'unknown']);
  expect(pressure.shortage).toBe(false);
});
