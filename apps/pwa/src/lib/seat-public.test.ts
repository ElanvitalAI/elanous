import { describe, expect, test } from 'bun:test';
import { maskPublicRefs, seatLineIsPublicSafe, seatNowLine } from './seat-public';

describe('seatLineIsPublicSafe', () => {
  test('rejects each private marker instead of masking it', () => {
    for (const line of [
      '/Users/owner/file', '~/.elanous/secret', 'elt_token', '$1,200', '$-5', 'run-abcdef12',
      'test:run', 'mirror:sync', 'account-1', 'remote-2', 'msb3', 'host.ts.net',
      'gcpvm', 'user', 'person@example.com',
    ]) expect(seatLineIsPublicSafe(`오늘 ${line} 처리`)).toBe(false);
  });
  test('rejects a private home-directory key path absent from the original marker list', () => {
    expect(seatLineIsPublicSafe('/home/ubuntu/.ssh/id_rsa')).toBe(false);
  });
  test('keeps safe Korean status and amounts without dollar markers', () => {
    expect(seatLineIsPublicSafe('오늘 착지 3 · 검토 완료')).toBe(true);
  });
});

describe('seatNowLine and the crown marker (10-02 harvest review)', () => {
  test('strips identity, timestamp and recipients from a channel first line', () => {
    expect(seatNowLine('**[OP]** 2026-10-02 15:51 KST → MK · UX · TC (대표 «메인이 뒤처져 있다») — 각자 작업 트리를 main 최신으로'))
      .toBe('(대표 «메인이 뒤처져 있다») — 각자 작업 트리를 main 최신으로');
    expect(seatNowLine('**[UX]** 2026-10-02 15:45 KST → TC OP · PCH-2b 경계 나눔 제안')).toBe('PCH-2b 경계 나눔 제안');
    expect(seatNowLine('그냥 한 줄')).toBe('그냥 한 줄');
    // 10-03 live: the dash and kind word after the recipients were left on the board.
    expect(seatNowLine('**[UX]** 2026-10-03 19:20 KST → OP — 보고 · 정시 · 쏜 수 38')).toBe('정시 · 쏜 수 38');
  });

  test('a line carrying the crown marker is not public-safe', () => {
    expect(seatLineIsPublicSafe(`결정 기다림 (${String.fromCodePoint(0x1F451)} 10:3x)`)).toBe(false);
    expect(seatLineIsPublicSafe('결정 기다림')).toBe(true);
  });
});

test('public refs and markdown emphasis', () => {
  expect(maskPublicRefs('보류 PR 검토 — #22745 이미 병합 · #22793 · #22797')).toBe('보류 PR 검토 — PR 이미 병합 · PR · PR');
  expect(seatNowLine('**[OP]** 2026-10-02 16:01 KST → UX · **#22793 은 병합**')).toBe('#22793 은 병합');
});

test('commit hashes and code spans make a line private, plain numbers do not', () => {
  expect(seatLineIsPublicSafe('트리 main 최신 47805d41e6 · behind 0')).toBe(false);
  expect(seatLineIsPublicSafe('골 문서 `ASK-the-launch` 를 읽었다')).toBe(false);
  expect(seatLineIsPublicSafe('오늘 착지 27 · 막힘 0 · 2026-10-02')).toBe(true);
  expect(seatLineIsPublicSafe('decade facade')).toBe(true);
});
