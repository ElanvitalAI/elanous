import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import {
  latestSlotCapacityPolicy,
  readResourceLedger,
  recordSlotCapacityPolicy,
  requestSlotLease,
  type SlotLeaseRequest,
} from './resource-ledger.js';

// SEC-FU (JUD-2 필수 2): 슬롯 상한 값 출처 검증(RES 가 쓴 원장 행만 신뢰) + 기존 승인 재반환 동일성 가드.
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tempLedger = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'slot-policy-'));
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
  ttlMs: 60_000, // 출처: #39758 — 게이트 슬롯 임대 기본 TTL 60초(#39745 요청 픽스처 규격)
  env: { imageFresh: true, namespace: 'elanous-test', providersAvailable: 2 }, // 출처: #39758 — 검증 가능 최소 공급자 2(§A-L 계약)
  ...overrides,
});

test('SEC-FU 통과 ① — a RES-authored slot-capacity-policy ledger row is the only trusted cap for a grant', () => {
  const path = tempLedger();
  recordSlotCapacityPolicy({ kind: 'gate-slot', host: 'mbp', capacity: 1, version: 'phase-policy-1' }, now, path); // 출처: #39758 — RES 정책 행 기록(상한 1)
  expect(requestSlotLease(request(), { now, path, policy: { capacity: 1, version: 'phase-policy-1', writtenBy: 'RES' } })) // 출처: #39758 — 승인 상한 1(원장 행 일치)
    .toEqual({ status: 'granted', leaseId: 'slot:gate-slot:req-1', expiresAt: '2026-11-23T00:01:00.000Z', policyVersion: 'phase-policy-1' });
  const events = readResourceLedger(path);
  expect(events.filter(event => event.event === 'slot-capacity-policy')).toHaveLength(1); // 출처: #39758 — 정책 행 1개 기록 단언
  expect(latestSlotCapacityPolicy(events, 'gate-slot', 'mbp')).toEqual({ kind: 'gate-slot', host: 'mbp', capacity: 1, version: 'phase-policy-1' }); // 출처: #39758 — 최신 RES 행 회신(상한 1)
  expect(latestSlotCapacityPolicy(events, 'gate-slot', 'node-c')).toBeUndefined();
  expect(latestSlotCapacityPolicy(events, 'pod-pool', 'mbp')).toBeUndefined();
});

test('SEC-FU 통과 ② — an identical re-request (host·runId·consumer all equal) replays the standing grant idempotently', () => {
  const path = tempLedger();
  recordSlotCapacityPolicy({ kind: 'gate-slot', host: 'mbp', capacity: 1, version: 'phase-policy-1' }, now, path); // 출처: #39758 — RES 정책 행 기록(상한 1)
  const policy = { capacity: 1, version: 'phase-policy-1', writtenBy: 'RES' } as const; // 출처: #39758 — 승인 상한 1(원장 행 일치)
  const first = requestSlotLease(request(), { now, path, policy });
  if (first.status !== 'granted') throw new Error('expected grant');
  expect(requestSlotLease(request(), { now, path, policy })).toEqual(first);
  expect(readResourceLedger(path).filter(event => event.event === 'lease.granted')).toHaveLength(1); // 출처: #39758 — 멱위 재생 시 부여 1개 단언
});

test('SEC-FU 거부 ① — a forged writer or a RES claim without a matching ledger row denies with policy-untrusted', () => {
  const path = tempLedger();
  recordSlotCapacityPolicy({ kind: 'gate-slot', host: 'mbp', capacity: 1, version: 'phase-policy-1' }, now, path); // 출처: #39758 — RES 정책 행 기록(상한 1)
  expect(requestSlotLease(request({ requestId: 'forge' }), { now, path, policy: { capacity: 1, version: 'phase-policy-1', writtenBy: 'OP' } })) // 출처: #39758 — 위조 작성자 거부 픽스처(상한 1)
    .toEqual({ status: 'denied', reasonCode: 'policy-untrusted', alternatives: ['mshq', 'node-c', 'aws1', 'gcp2'] });
  expect(requestSlotLease(request({ requestId: 'norow' }), { now, path, policy: { capacity: 1, version: 'v-other', writtenBy: 'RES' } })) // 출처: #39758 — 행 없는 버전 거부 픽스처(상한 1)
    .toEqual({ status: 'denied', reasonCode: 'policy-untrusted', alternatives: ['mshq', 'node-c', 'aws1', 'gcp2'] });
  expect(requestSlotLease(request({ requestId: 'cap-lift', host: 'node-c' }), { now, path, policy: { capacity: 99, version: 'phase-policy-1', writtenBy: 'RES' } })) // 출처: #39758 — 상한 위조 99(원장 행 1과 불일치)
    .toEqual({ status: 'denied', reasonCode: 'policy-untrusted', alternatives: ['mshq', 'aws1', 'gcp2'] });
  const events = readResourceLedger(path);
  expect(events.filter(event => event.event === 'lease.denied').map(event => event.reasonCode))
    .toEqual(['policy-untrusted', 'policy-untrusted', 'policy-untrusted']);
  expect(events.filter(event => event.event === 'lease.granted')).toHaveLength(0); // 출처: #39758 — 거부 시 부여 0 단언
});

test('SEC-FU 거부 ②(ⓑ 가드) — a re-request with a different host·runId·consumer never replays the standing grant: fresh fail-closed decision', () => {
  const path = tempLedger();
  recordSlotCapacityPolicy({ kind: 'gate-slot', host: 'mbp', capacity: 1, version: 'phase-policy-1' }, now, path); // 출처: #39758 — RES 정책 행 기록(상한 1)
  const policy = { capacity: 1, version: 'phase-policy-1', writtenBy: 'RES' } as const; // 출처: #39758 — 승인 상한 1(원장 행 일치)
  const standing = requestSlotLease(request({ requestId: 'req-9' }), { now, path, policy });
  if (standing.status !== 'granted') throw new Error('expected grant');
  expect(requestSlotLease(request({ requestId: 'req-9', runId: 'run-2' }), { now, path, policy }))
    .toEqual({ status: 'denied', reasonCode: 'request-owner-mismatch', alternatives: [] });
  expect(requestSlotLease(request({ requestId: 'req-9', consumer: 'ta-launch' }), { now, path, policy }))
    .toEqual({ status: 'denied', reasonCode: 'request-owner-mismatch', alternatives: [] });
  expect(requestSlotLease(request({ requestId: 'req-9', host: 'node-c' }), { now, path, policy }))
    .toEqual({ status: 'denied', reasonCode: 'request-owner-mismatch', alternatives: [] });
  expect(requestSlotLease(request({ requestId: 'req-10' }), { now, path, policy }))
    .toEqual({ status: 'queued', position: 1, alternatives: ['mshq', 'node-c', 'aws1', 'gcp2'] }); // 출처: #39758 — 포화 대기열 위치 1(§A-L 대안 규격)
  const events = readResourceLedger(path);
  expect(events.filter(event => event.event === 'lease.granted')).toHaveLength(1); // 출처: #39758 — 기존 승인 1개 보존 단언
  expect(events.filter(event => event.event === 'lease.violation')).toHaveLength(3); // 출처: #39758 — 불일치 재요청 3건 감사 단언
  expect(events.filter(event => event.event === 'lease.requested')).toHaveLength(2); // 출처: #39758 — 신규 요청 2건(부여+대기) 단언
});