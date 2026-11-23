import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import {
  readResourceLedger,
  recordSlotCapacityPolicy,
  reapSlotLeaseIfCurrent,
  recordSlotLeaseViolation,
  releaseSlotLease,
  requestSlotLease,
  type ResourceLedgerEvent,
  type SlotLeaseRequest,
} from './resource-ledger.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tempLedger = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'slot-lease-'));
  dirs.push(dir);
  return join(dir, 'events.jsonl');
};
const now = new Date('2026-11-23T00:00:00.000Z');
const request = (overrides: Partial<SlotLeaseRequest> = {}): SlotLeaseRequest => ({
  requestId: 'req-1',
  kind: 'gate-slot',
  host: 'mbp',
  runId: 'run-1',
  consumer: 'pregate',
  purpose: 'remote-pregate',
  ttlMs: 60_000,
  env: { imageFresh: true, namespace: 'elanous-test', providersAvailable: 2 },
  ...overrides,
});
const policy = { capacity: 1, version: 'phase-policy-1', writtenBy: 'RES' }; // 출처: #39745 — 만료·대기열 검증 픽스처 최소 용량(RES 작성)

test('requestSlotLease denies stale image, missing namespace, zero providers, and unknown capacity (§A-L env contract)', () => {
  const path = tempLedger();
  expect(requestSlotLease(request({ requestId: 'img', env: { imageFresh: false, namespace: 'elanous-test', providersAvailable: 2 } }), { now, path, policy }))
    .toEqual({ status: 'denied', reasonCode: 'env-image-stale', alternatives: [] });
  expect(requestSlotLease(request({ requestId: 'ns', env: { imageFresh: true, namespace: '', providersAvailable: 2 } }), { now, path, policy }))
    .toEqual({ status: 'denied', reasonCode: 'env-namespace', alternatives: [] });
  expect(requestSlotLease(request({ requestId: 'prov', env: { imageFresh: true, namespace: 'elanous-test', providersAvailable: 0 } }), { now, path, policy }))
    .toEqual({ status: 'denied', reasonCode: 'env-no-provider', alternatives: [] });
  expect(requestSlotLease(request({ requestId: 'cap' }), { now, path }))
    .toEqual({ status: 'denied', reasonCode: 'capacity-unknown', alternatives: ['mshq', 'node-c', 'aws1', 'gcp2'] });
  expect(requestSlotLease(request({ requestId: 'badcap' }), { now, path, policy: { capacity: Number.NaN, writtenBy: 'RES' } }))
    .toEqual({ status: 'denied', reasonCode: 'capacity-invalid', alternatives: ['mshq', 'node-c', 'aws1', 'gcp2'] });
  expect(requestSlotLease(request({ requestId: 'invalid', host: '' }), { now, path, policy }))
    .toEqual({ status: 'denied', reasonCode: 'invalid-request', alternatives: [] });
  const events = readResourceLedger(path);
  expect(events.filter(event => event.event === 'lease.requested')).toHaveLength(5);
  expect(events.filter(event => event.event === 'lease.granted')).toHaveLength(0);
  expect(events.filter(event => event.event === 'lease.denied')
    .map(event => event.reasonCode)).toEqual(['env-image-stale', 'env-namespace', 'env-no-provider', 'capacity-unknown', 'capacity-invalid']);
});

test('requestSlotLease fails closed on an unreadable ledger — no implicit grant', () => {
  const path = tempLedger();
  writeFileSync(path, '{not json\n', 'utf8');
  expect(requestSlotLease(request(), { now, path, policy }))
    .toEqual({ status: 'denied', reasonCode: 'ledger-unavailable', alternatives: [] });
});

test('a full capacity policy queues with position and alternative hosts instead of over-allocating', () => {
  const path = tempLedger();
  recordSlotCapacityPolicy({ kind: 'pod-pool', host: 'node-c', capacity: 1, version: 'v1' }, now, path); // 출처: #39745 — pod-pool 포화 검증 RES 정책 행
  const podRequest = (overrides: Partial<SlotLeaseRequest> = {}) => request({ kind: 'pod-pool', host: 'node-c', ...overrides });
  expect(requestSlotLease(podRequest({ requestId: 'pod-1' }), { now, path, policy: { capacity: 1, version: 'v1', writtenBy: 'RES' } })) // 출처: #39745 — capacity 1 포화에서 첫 요청 granted
    .toEqual({ status: 'granted', leaseId: 'slot:pod-pool:pod-1', expiresAt: '2026-11-23T00:01:00.000Z', policyVersion: 'v1' });
  expect(requestSlotLease(podRequest({ requestId: 'pod-2' }), { now, path, policy: { capacity: 1, version: 'v1', writtenBy: 'RES' } })) // 출처: #39745 — capacity 1 포화에서 queued 위치 1
    .toEqual({ status: 'queued', position: 1, alternatives: ['mshq', 'aws1', 'gcp2'] });
  expect(requestSlotLease(podRequest({ requestId: 'pod-3' }), { now, path, policy: { capacity: 1, version: 'v1', writtenBy: 'RES' } })) // 출처: #39745 — capacity 1 포화에서 queued 위치 2
    .toEqual({ status: 'queued', position: 2, alternatives: ['mshq', 'aws1', 'gcp2'] });
  expect(readResourceLedger(path).filter(event => event.event === 'lease.granted')).toHaveLength(1);
});

test('releaseSlotLease is idempotent, requires a reason, and frees capacity', () => {
  const path = tempLedger();
  recordSlotCapacityPolicy({ kind: 'gate-slot', host: 'mbp', capacity: 1, version: 'phase-policy-1' }, now, path); // 출처: #39745 — 해제·재부여 검증 RES 정책 행
  const granted = requestSlotLease(request(), { now, path, policy });
  if (granted.status !== 'granted') throw new Error('expected grant');
  expect(() => releaseSlotLease(granted.leaseId, ' ', now, path)).toThrow('slot lease release requires leaseId and reason');
  expect(() => releaseSlotLease('', 'done', now, path)).toThrow('slot lease release requires leaseId and reason');
  expect(releaseSlotLease(granted.leaseId, 'completed', now, path)).toBe(true);
  expect(releaseSlotLease(granted.leaseId, 'duplicate-release', now, path)).toBe(false);
  const released = readResourceLedger(path).filter(event => event.event === 'lease.released');
  expect(released).toHaveLength(1);
  expect(released[0]).toMatchObject({ leaseId: granted.leaseId, reason: 'completed' });
  expect(requestSlotLease(request({ requestId: 'req-2' }), { now, path, policy }).status).toBe('granted');
});

test('reapSlotLeaseIfCurrent reaps an expired slot lease only under the exact expected expiry (CAS)', () => {
  const path = tempLedger();
  recordSlotCapacityPolicy({ kind: 'gate-slot', host: 'mbp', capacity: 1, version: 'phase-policy-1' }, now, path); // 출처: #39745 — CAS 만료 회수 검증 RES 정책 행
  const granted = requestSlotLease(request({ ttlMs: 1_000 }), { now, path, policy });
  if (granted.status !== 'granted') throw new Error('expected grant');
  const afterExpiry = now.getTime() + 1_001;
  expect(reapSlotLeaseIfCurrent({ leaseId: granted.leaseId, expectedExpiresAt: new Date(now.getTime() + 2_000).toISOString(), observedAtMs: afterExpiry }, path)).toBe(false);
  expect(reapSlotLeaseIfCurrent({ leaseId: granted.leaseId, expectedExpiresAt: granted.expiresAt, observedAtMs: now.getTime() }, path)).toBe(false);
  expect(reapSlotLeaseIfCurrent({ leaseId: granted.leaseId, expectedExpiresAt: granted.expiresAt, observedAtMs: afterExpiry }, path)).toBe(true);
  expect(reapSlotLeaseIfCurrent({ leaseId: granted.leaseId, expectedExpiresAt: granted.expiresAt, observedAtMs: afterExpiry }, path)).toBe(false);
  expect(readResourceLedger(path).at(-1)).toMatchObject({ event: 'lease.expired', leaseId: granted.leaseId });

  const lazyPath = tempLedger();
  recordSlotCapacityPolicy({ kind: 'gate-slot', host: 'mbp', capacity: 1, version: 'phase-policy-1' }, now, lazyPath); // 출처: #39745 — 지연 만료 회수 검증 RES 정책 행
  const short = requestSlotLease(request({ requestId: 'short', ttlMs: 10 }), { now, path: lazyPath, policy });
  if (short.status !== 'granted') throw new Error('expected grant');
  expect(requestSlotLease(request({ requestId: 'next' }), { now: new Date(now.getTime() + 100), path: lazyPath, policy }).status).toBe('granted');
  expect(readResourceLedger(lazyPath).filter(event => event.event === 'lease.expired')).toHaveLength(1);
});

test('a healthy request grants with lease.requested→lease.granted, replays idempotently, and records violations', () => {
  const path = tempLedger();
  recordSlotCapacityPolicy({ kind: 'gate-slot', host: 'mbp', capacity: 1, version: 'phase-policy-1' }, now, path); // 출처: #39745 — 정상 부여·멱위 재생 검증 RES 정책 행
  // Forward compatibility: unknown event types are skipped, not fatal.
  appendFileSync(path, `${JSON.stringify({ event: 'future-slot-event', at: now.toISOString() })}\n`, 'utf8');
  const granted = requestSlotLease(request(), { now, path, policy });
  if (granted.status !== 'granted') throw new Error('expected grant');
  expect(granted).toEqual({ status: 'granted', leaseId: 'slot:gate-slot:req-1', expiresAt: '2026-11-23T00:01:00.000Z', policyVersion: 'phase-policy-1' });
  const decisionEvents: ResourceLedgerEvent[] = readResourceLedger(path)
    .filter(event => event.event === 'lease.requested' || event.event === 'lease.granted');
  expect(decisionEvents.map(event => event.event)).toEqual(['lease.requested', 'lease.granted']);
  expect(requestSlotLease(request(), { now, path, policy })).toEqual(granted);
  expect(readResourceLedger(path).filter(event => event.event === 'lease.granted')).toHaveLength(1);
  recordSlotLeaseViolation({ host: 'mbp', leaseId: granted.leaseId, detail: 'launch without grant' }, now, path);
  expect(readResourceLedger(path).at(-1)).toMatchObject({ event: 'lease.violation', host: 'mbp', leaseId: granted.leaseId, detail: 'launch without grant' });
});
