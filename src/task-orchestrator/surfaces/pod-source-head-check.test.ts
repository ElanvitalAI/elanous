import { expect, test } from 'bun:test';
import { podSourceHeadFailure, podSourceHeadGate, verifyPodSourceHead } from './pod-source-head-check.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

test('commit 핀 + 같은 HEAD = match', () => {
  const v = verifyPodSourceHead(`x\nELANOUS_POD_SOURCE commit ${A}\ny`, { kind: 'commit', sha: A });
  expect(v.verdict).toBe('match');
  expect(podSourceHeadFailure(v)).toBeNull();
});
test('다른 HEAD = mismatch → 발사 실패 사유', () => {
  const v = verifyPodSourceHead(`ELANOUS_POD_SOURCE commit ${B}`, { kind: 'commit', sha: A });
  expect(v.verdict).toBe('mismatch');
  expect(podSourceHeadFailure(v)).toContain('불일치');
});
test('영수증 줄 없음/로그 없음 = missing → 실패 (조용한 0 금지)', () => {
  for (const logs of [null, '', 'ELANOUS_POD_SOURCE default ' + A]) {
    const v = verifyPodSourceHead(logs, { kind: 'commit', sha: A });
    expect(v.verdict).toBe('missing');
    expect(podSourceHeadFailure(v)).toContain('영수증 없음');
  }
});
test('commit 핀이 아니면 not-applicable', () => {
  expect(verifyPodSourceHead(null, undefined).verdict).toBe('not-applicable');
  expect(verifyPodSourceHead(null, { kind: 'default' }).verdict).toBe('not-applicable');
  expect(podSourceHeadFailure(verifyPodSourceHead(null, { kind: 'pr', number: 1 }))).toBeNull();
});

test('게이트: clone 중 OOM(state=failed)·중단은 영수증 없어도 mismatch 로 덮지 않는다 — 기존 OOM 재시도 유지', () => {
  const missing = verifyPodSourceHead(null, { kind: 'commit', sha: A });
  expect(podSourceHeadGate(missing, { state: 'failed', aborted: false })).toBeNull();
  expect(podSourceHeadGate(missing, { state: 'aborted', aborted: true })).toBeNull();
  expect(podSourceHeadGate(missing, { state: 'complete', aborted: true })).toBeNull();
});
test('게이트: 정상 종료인데 영수증 없음/불일치만 실패', () => {
  const run = { state: 'complete' as const, aborted: false };
  expect(podSourceHeadGate(verifyPodSourceHead(null, { kind: 'commit', sha: A }), run)).toContain('영수증 없음');
  expect(podSourceHeadGate(verifyPodSourceHead(`ELANOUS_POD_SOURCE commit ${B}`, { kind: 'commit', sha: A }), run)).toContain('불일치');
  expect(podSourceHeadGate(verifyPodSourceHead(`ELANOUS_POD_SOURCE commit ${A}`, { kind: 'commit', sha: A }), run)).toBeNull();
});
