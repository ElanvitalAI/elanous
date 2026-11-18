import { expect, test } from 'bun:test';
import { nextTuiErrorCard } from './error-card.js';

test('failure card keeps public detail safe and gives one compact recovery line', () => {
  const secret = `sk-or-v1-${'d'.repeat(64)}`;
  const lines = nextTuiErrorCard(`provider unavailable\x1b[2J\n${secret}`);
  expect(lines).toHaveLength(2);
  expect(lines[0]).toContain('✘ provider unavailable sk-or-v1-***');
  expect(lines[0]).not.toContain(secret);
  expect(lines[0]).not.toContain('\x1b');
  expect(lines[1]).toBe('  ↑ recall input → Enter resend · check /provider · /resume to continue');
});

test('empty failure detail still leaves the recovery actions visible', () => {
  expect(nextTuiErrorCard('')[0]).toBe('✘ No error detail');
});

test('known authentication failure directs connection repair before retry', () => {
  expect(nextTuiErrorCard('Codex 인증이 준비되지 않았습니다.', 'codex-auth-missing')[1])
    .toBe('  Check /provider · renew auth → ↑ recall input → Enter resend');
});
