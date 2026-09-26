import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResourceLedger } from './ledger.js';
import { leasePort, MAX_PORT_LEASE_TTL_MS, PORT_BANDS, portLeaseId } from './ports.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function ledger(): ResourceLedger {
  const root = mkdtempSync(join(tmpdir(), 'control-ports-'));
  roots.push(root);
  return new ResourceLedger(root);
}
const request = { machine: 'machine-a', purpose: 'nexus-test', ttlMs: 100 };

test('bands reserve production ports and separate test and offline candidates', () => {
  expect(PORT_BANDS.reserved).toEqual([31413, 31415, 31420]);
  expect(PORT_BANDS.test).toEqual({ start: 31450, end: 31499 });
  expect(PORT_BANDS.offline).toEqual({ start: 31500, end: 31509 });
});

test('two lowest ports are persisted, and expired leases become reusable at the TTL boundary', () => {
  const store = ledger();
  expect(leasePort(request, store, 1000)).toMatchObject({ id: portLeaseId(31450), kind: 'port-lease', machine: 'machine-a', attrs: { port: 31450, purpose: 'nexus-test' }, observedAt: 1000, ttlMs: 100 });
  expect(leasePort(request, store, 1000).attrs.port).toBe(31451);
  expect(new ResourceLedger(roots.at(-1)!).list({ kind: 'port-lease' }, 1099)).toHaveLength(2);
  expect(statSync(store.path).mode & 0o777).toBe(0o600);
  expect(leasePort(request, store, 1099).attrs.port).toBe(31452);
  expect(leasePort({ ...request, machine: 'machine-b', owner: 'other-token' }, store, 1100).attrs.port).toBe(31450);
  expect(store.list({ kind: 'port-lease' }, 1100).find(row => row.id === portLeaseId(31450))).toMatchObject({ owner: 'other-token', expired: false });
});

test('expired lease cannot be renewed after another owner reclaims its port', () => {
  const store = ledger();
  const first = leasePort(request, store, 1000);
  const firstId = first.attrs.leaseId as string;
  expect(() => store.renewTestPort(31450, 'machine-a', firstId, 1100)).toThrow('lease-expired');
  const next = leasePort({ ...request, machine: 'machine-b', owner: 'machine-b' }, store, 1100);
  expect(next.attrs.leaseId).not.toBe(firstId);
  expect(() => store.renewTestPort(31450, 'machine-a', firstId, 1101)).toThrow('not-owner');
  expect(store.renewTestPort(31450, 'machine-b', next.attrs.leaseId as string, 1101).observedAt).toBe(1101);
});

test('same member cannot renew or delete a reallocated lease using the old lease id', () => {
  const store = ledger();
  const first = leasePort(request, store, 1000);
  const oldId = first.attrs.leaseId as string;
  const second = leasePort(request, store, 1100);
  const newId = second.attrs.leaseId as string;
  expect(newId).not.toBe(oldId);
  expect(() => store.renewTestPort(31450, 'machine-a', oldId, 1101)).toThrow('not-owner');
  expect(() => store.deleteTestPort(31450, 'machine-a', oldId)).toThrow('not-owner');
  expect(store.renewTestPort(31450, 'machine-a', newId, 1101).attrs.leaseId).toBe(newId);
  store.deleteTestPort(31450, 'machine-a', newId);
  expect(store.list()).toEqual([]);
});

test('exhaustion reports no-port; deleted lease is reused before any higher free port', () => {
  const store = ledger();
  const ports = Array.from({ length: 50 }, () => Number(leasePort(request, store, 1000).attrs.port));
  expect(ports).toEqual(Array.from({ length: 50 }, (_, i) => 31450 + i));
  expect(ports.some(port => (PORT_BANDS.reserved as readonly number[]).includes(port))).toBe(false);
  expect(() => leasePort(request, store, 1001)).toThrow('no-port');
  store.delete(portLeaseId(31450), 'machine-a');
  expect(leasePort(request, store, 1001).attrs.port).toBe(31450);
});

test('collision exclusions skip the released occupied port without affecting other active leases', () => {
  const store = ledger();
  const first = leasePort(request, store, 1000);
  store.delete(first.id, 'machine-a');
  const next = leasePort({ ...request, excluded: [31450] }, store, 1001);
  expect(next.attrs.port).toBe(31451);
  expect(store.list({ kind: 'port-lease' }, 1001).map(row => row.attrs.port)).toEqual([31451]);
});

test('invalid lease request does not write a ledger', () => {
  const store = ledger();
  expect(() => leasePort({ ...request, ttlMs: 0 }, store)).toThrow('invalid-port-lease');
  expect(store.list()).toEqual([]);
});

test('a lease ttl longer than the cap is clipped to 24 hours; shorter ones are kept', () => {
  const store = ledger();
  expect(MAX_PORT_LEASE_TTL_MS).toBe(24 * 60 * 60 * 1000);
  expect(leasePort({ ...request, ttlMs: Number.MAX_SAFE_INTEGER }, store, 1000).ttlMs).toBe(MAX_PORT_LEASE_TTL_MS);
  expect(leasePort({ ...request, ttlMs: MAX_PORT_LEASE_TTL_MS + 1 }, store, 1000).ttlMs).toBe(MAX_PORT_LEASE_TTL_MS);
  expect(leasePort({ ...request, ttlMs: 30_000 }, store, 1000).ttlMs).toBe(30_000);
  // 잘린 임대는 24시간 뒤 만료되어 다른 주인이 되찾을 수 있다.
  expect(leasePort({ ...request, machine: 'machine-b', owner: 'machine-b' }, store, 1000 + MAX_PORT_LEASE_TTL_MS).attrs.port).toBe(31450);
});
