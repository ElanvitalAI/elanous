import { expect, test } from 'bun:test';
import { nextTuiErrorCard } from './error-card.js';

test('failure card reports a sanitized error and retry, provider-change, and resume routes', () => {
  const secret = `sk-or-v1-${'d'.repeat(64)}`;
  const lines = nextTuiErrorCard(`provider unavailable\x1b[2J\n${secret}`);
  expect(lines).toHaveLength(2);
  expect(lines[0]).toContain('✘ 응답 실패 · provider unavailable sk-or-v1-***');
  expect(lines[0]).not.toContain(secret);
  expect(lines[0]).not.toContain('\x1b');
  expect(lines[1]).toBe('재시도: ↑ 이전 입력 후 Enter · 제공자 변경: /provider · 이어가기: /resume');
});

test('empty failure detail still leaves the recovery actions visible', () => {
  expect(nextTuiErrorCard('')[0]).toBe('✘ 응답 실패 · 오류 상세 없음');
});
