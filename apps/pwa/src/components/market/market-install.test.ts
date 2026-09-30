import { describe, expect, test } from 'bun:test';
import { installProgressFromLine } from './market-install';

test('NDJSON installer events become user-facing steps without exposing payloads', () => {
  expect(['resolve', 'verify', 'consent', 'credentials', 'registered', 'done'].map(event =>
    installProgressFromLine(JSON.stringify({ event, secret: 'never-display', required: true }))?.step))
    .toEqual(['받는 중', '서명 확인', '권한 동의', '자격 필요', '등록', '완료']);
  expect(installProgressFromLine('{"event":"credentials","required":false}')).toBeNull();
  expect(installProgressFromLine('{"event":"failed","reason":"consent-denied","secret":"never-display"}'))
    .toEqual({ step: '실패', reason: '필요한 권한에 동의하지 않았습니다.' });
  expect(installProgressFromLine('{"event":"failed","reason":"arbitrary secret"}')?.reason).toBe('설치 중 오류가 발생했습니다.');
  expect(installProgressFromLine('not json')).toBeNull();
});

describe('failed line carries the one-line cause', () => {
  test('detail is appended to the reason sentence', () => {
    const p = installProgressFromLine(JSON.stringify({ event: 'failed', reason: 'io', detail: 'artifact unavailable: elanous-basics/0.1.0/abc.tgz' }));
    expect(p?.step).toBe('실패');
    expect(p?.reason).toBe('설치 중 오류가 발생했습니다. — artifact unavailable: elanous-basics/0.1.0/abc.tgz');
  });
  test('without detail the reason sentence stays as before', () => {
    expect(installProgressFromLine(JSON.stringify({ event: 'failed', reason: 'signature' }))?.reason).toBe('서명을 확인하지 못했습니다.');
  });
});
