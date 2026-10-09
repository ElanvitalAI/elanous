import { expect, test } from 'bun:test';
import { adviseLaunch, compareLaunchAdvice } from './launch-advice.js';

test('pool saturation, free capacity and unreadable pool stay distinct', () => {
  const caller = 'harness-queue-tick' as const;
  expect(adviseLaunch({ caller, pool: { running: 8, pending: 0, reserved: 0, limit: 8 } })).toMatchObject({ verdict: 'wait' });
  expect(adviseLaunch({ caller, pool: { running: 2, pending: 0, reserved: 0, limit: 8 } })).toMatchObject({ verdict: 'launch-now' });
  expect(adviseLaunch({ caller, pool: undefined })).toMatchObject({ verdict: 'unknown' });
  expect(adviseLaunch({ caller, pool: { running: 2, pending: 3, reserved: 3, limit: 8 } }).verdict).toBe('wait');
});

test('comparison separates mismatches from agreement and unknown evidence', () => {
  const wait = adviseLaunch({ caller: 'hand-task', pool: { running: 8, pending: 0, reserved: 0, limit: 8 } });
  const now = adviseLaunch({ caller: 'release-run', pool: { running: 2, pending: 0, reserved: 0, limit: 8 } });
  const unknown = adviseLaunch({ caller: 'harness-queue-tick', pool: undefined });
  expect(compareLaunchAdvice(wait, 'launched')).toEqual({ agree: false, kind: 'advice-wait-actual-launch' });
  expect(compareLaunchAdvice(now, 'waiting')).toEqual({ agree: false, kind: 'advice-launch-actual-wait' });
  expect(compareLaunchAdvice(unknown, 'waiting')).toEqual({ agree: false, kind: 'advice-unknown' });
  expect(compareLaunchAdvice(now, 'skipped')).toEqual({ agree: false, kind: 'advice-unknown' });
  expect(compareLaunchAdvice(now, 'launched')).toEqual({ agree: true, kind: 'agree' });
  expect(compareLaunchAdvice(wait, 'waiting')).toEqual({ agree: true, kind: 'agree' });
});
