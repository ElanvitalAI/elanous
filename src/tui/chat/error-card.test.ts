import { expect, test } from 'bun:test';
import { nextTuiErrorCard } from './error-card.js';

test('failure card keeps public detail safe and gives one compact recovery line', () => {
  const secret = `sk-or-v1-${'d'.repeat(64)}`;
  const lines = nextTuiErrorCard(`provider unavailable\x1b[2J\n${secret}`);
  expect(lines).toHaveLength(2);
  expect(lines[0]).toContain('✘ provider unavailable sk-or-v1-***');
  expect(lines[0]).not.toContain(secret);
  expect(lines[0]).not.toContain('\x1b');
  expect(lines[1]).toBe('  ↑ 입력 불러오기 → Enter 재전송 · /provider 확인');
});

test('empty failure detail still leaves the recovery actions visible', () => {
  expect(nextTuiErrorCard('')[0]).toBe('✘ 오류 상세 없음');
});

test('known authentication failure directs connection repair before retry', () => {
  expect(nextTuiErrorCard('Codex 인증이 준비되지 않았습니다.', 'codex-auth-missing')[1])
    .toBe('  /provider 연결 확인 · 인증 갱신 → ↑ 입력 불러오기 → Enter 재전송');
});
