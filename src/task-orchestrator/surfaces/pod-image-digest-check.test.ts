import { expect, test } from 'bun:test';
import { isImageDigestPin, podImageDigestGate, requestedImageDigest, verifyPodImageDigest } from './pod-image-digest-check.js';

const A = `sha256:${'a'.repeat(64)}`;
const B = `sha256:${'b'.repeat(64)}`;
const run = { state: 'complete' as const, aborted: false };

test('pin 추출: ref 의 @digest · 명시 값 · 불량 명시는 던진다', () => {
  expect(requestedImageDigest(`reg/x@${A}`)).toBe(A);
  expect(requestedImageDigest('reg/x:latest')).toBeNull();
  expect(requestedImageDigest('reg/x:latest', A)).toBe(A);
  expect(() => requestedImageDigest('reg/x', 'latest')).toThrow(/형식 불량/);
});
test('match/mismatch/unobserved/no-pin', () => {
  expect(verifyPodImageDigest(A, { digest: A, digestUnavailable: null }).verdict).toBe('match');
  expect(verifyPodImageDigest(A, { digest: B, digestUnavailable: null }).verdict).toBe('mismatch');
  expect(verifyPodImageDigest(A, { digest: null, digestUnavailable: 'image-id-missing' }).verdict).toBe('unobserved');
  expect(verifyPodImageDigest(null, { digest: B, digestUnavailable: null }).verdict).toBe('no-pin');
});
test('게이트: complete 에서만 mismatch/unobserved 실패 · failed/aborted·match·no-pin 은 null', () => {
  const mm = verifyPodImageDigest(A, { digest: B, digestUnavailable: null });
  const un = verifyPodImageDigest(A, { digest: null, digestUnavailable: 'x' });
  expect(podImageDigestGate(mm, run)).toContain('불일치');
  expect(podImageDigestGate(un, run)).toContain('미관측');
  expect(podImageDigestGate(mm, { state: 'failed', aborted: false })).toBeNull();
  expect(podImageDigestGate(mm, { state: 'complete', aborted: true })).toBeNull();
  expect(podImageDigestGate(verifyPodImageDigest(A, { digest: A, digestUnavailable: null }), run)).toBeNull();
  expect(podImageDigestGate(verifyPodImageDigest(null, { digest: A, digestUnavailable: null }), run)).toBeNull();
});

test('isImageDigestPin 은 전체 일치 — 끝 줄바꿈·앞뒤 공백·탭·CRLF·대문자·ref 형태를 거부한다(세 입구 공용)', () => {
  expect(isImageDigestPin(A)).toBe(true);
  for (const bad of [`${A}\n`, `${A}\r\n`, `${A}\n\n`, ` ${A}`, `${A} `, `\t${A}`, `${A}\t`, `\n${A}`, A.replace('sha256', 'SHA256'), A.toUpperCase(), `reg/x@${A}`, `${A}0`, A.slice(0, -1), '', 'latest', null, undefined, 71, ['x']]) {
    expect(isImageDigestPin(bad)).toBe(false);
  }
});
test('requestedImageDigest 의 명시 pin 은 trim·소문자화로 구제하지 않는다(공백·줄바꿈·대문자 = 던짐)', () => {
  for (const bad of [`${A}\n`, ` ${A}`, `${A} `, A.toUpperCase().replace('SHA256:', 'sha256:')]) {
    expect(() => requestedImageDigest('reg/x', bad)).toThrow(/형식 불량/);
  }
  expect(requestedImageDigest('reg/x', A)).toBe(A);
});
