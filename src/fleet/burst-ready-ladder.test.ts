import { expect, test } from 'bun:test';
import { assertBurstAdmissionWindow, BURST_READY_PURPOSES, openBurstReadyLease, planBurstReadyLadder } from './burst-ready-ladder.js';

const HOUR_MS = 60 * 60 * 1000;
const ADMISSION_AT = Date.parse('2026-11-04T00:00:00Z');
const IMAGE = `sha256:${'a'.repeat(64)}`;

test('plans a one-hour warm-up and starts selected 2h or 4h TTL at admission for every purpose', () => {
  for (const purpose of BURST_READY_PURPOSES) {
    for (const ttlHours of [2, 4] as const) {
      const plan = planBurstReadyLadder({
        requestId: `${purpose}-${ttlHours}h`, purpose, imageDigest: IMAGE, admissionAt: ADMISSION_AT, ttlHours,
      });
      expect(plan).toEqual({
        requestId: `${purpose}-${ttlHours}h`,
        purpose,
        imageDigest: IMAGE,
        admissionAt: ADMISSION_AT,
        ttlHours,
        prepareAt: ADMISSION_AT - HOUR_MS,
        ttlMs: ttlHours * HOUR_MS,
        stopAfterAt: ADMISSION_AT + ttlHours * HOUR_MS,
      });
    }
  }
});

test('requires a safe id, a recognized purpose, a pinned image, and a supported TTL', () => {
  const valid = { requestId: 'gate-2h', purpose: 'gate' as const, imageDigest: IMAGE, admissionAt: ADMISSION_AT, ttlHours: 2 as const };
  expect(() => planBurstReadyLadder({ ...valid, requestId: '../escape' })).toThrow('requestId');
  expect(() => planBurstReadyLadder({ ...valid, purpose: 'other' as never })).toThrow('purpose');
  expect(() => planBurstReadyLadder({ ...valid, imageDigest: 'latest' })).toThrow('pinned sha256');
  expect(() => planBurstReadyLadder({ ...valid, admissionAt: Number.NaN })).toThrow('admissionAt');
  expect(() => planBurstReadyLadder({ ...valid, ttlHours: 3 as never })).toThrow('ttlHours');
});

test('refuses admission before its scheduled time and at TTL expiry', () => {
  const plan = planBurstReadyLadder({
    requestId: 'gate-2h', purpose: 'gate', imageDigest: IMAGE, admissionAt: ADMISSION_AT, ttlHours: 2,
  });

  expect(() => assertBurstAdmissionWindow(plan, plan.admissionAt - 1)).toThrow('before scheduled time');
  expect(() => assertBurstAdmissionWindow(plan, plan.admissionAt)).not.toThrow();
  expect(() => assertBurstAdmissionWindow(plan, plan.stopAfterAt - 1)).not.toThrow();
  expect(() => assertBurstAdmissionWindow(plan, plan.stopAfterAt)).toThrow('at or after TTL expiry');
  expect(() => assertBurstAdmissionWindow(plan, Number.NaN)).toThrow('finite epoch');
});

test('does not call the lease opener outside the scheduled admission window', () => {
  const plan = planBurstReadyLadder({
    requestId: 'gate-2h', purpose: 'gate', imageDigest: IMAGE, admissionAt: ADMISSION_AT, ttlHours: 2,
  });
  let opens = 0;
  const openLease = () => { opens++; return 'opened'; };

  expect(() => openBurstReadyLease(plan, plan.admissionAt - 1, openLease)).toThrow('before scheduled time');
  expect(opens).toBe(0);
  expect(openBurstReadyLease(plan, plan.admissionAt, openLease)).toBe('opened');
  expect(opens).toBe(1);
  expect(() => openBurstReadyLease(plan, plan.stopAfterAt, openLease)).toThrow('at or after TTL expiry');
  expect(opens).toBe(1);
});
