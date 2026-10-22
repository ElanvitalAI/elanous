import { expect, test } from 'bun:test';
import type { SerializedMessage } from '../../session/index.js';
import { WHEEL_SCROLL_LINES, fitLogLine, logViewLines, safeLogText, safeStatusText, streamReplyLines, wheelScroll } from './log-view.js';

test('history renders user and assistant text within terminal width without stored control codes', () => {
  const messages: SerializedMessage[] = [
    { role: 'system', content: 'hidden system prompt', ts: '2026-10-20T00:00:00Z' },
    { role: 'user', content: '가나다라마바\x1b[31mRED\x1b[0m\x1b]0;evil\x07', ts: '2026-10-20T00:00:01Z' },
    { role: 'assistant', content: '답변\n둘째 줄', ts: '2026-10-20T00:00:02Z' },
  ];
  const lines = logViewLines(messages, 12);
  expect(lines.join('\n')).toContain('가나다라');
  expect(lines.join('')).toContain('답변');
  expect(lines.join('\n')).not.toContain('hidden system prompt');
  expect(lines.join('\n')).not.toContain('\x1b');
  expect(lines.join('\n')).not.toContain('0;evil');
  expect(lines.every((line) => Bun.stringWidth(line) <= 12)).toBe(true);
  expect(safeLogText('title\x1b[2J')).toBe('title');
  expect(Bun.stringWidth(fitLogLine('긴 제목 가나다라마바사', 12))).toBeLessThanOrEqual(12);
});

test('empty history clearly marks the first slice as read only', () => {
  expect(logViewLines([], 20)).toEqual(['대화 기록 없음']);
});

test('tool execution and its result appear in the bounded conversation view', () => {
  const lines = logViewLines([{
    role: 'tool', content: '⚙️ Bash', toolName: 'Bash', toolResult: 'mail list rc=0\n2 messages', ts: '2026-10-20T00:00:00Z',
  }], 20);
  expect(lines.join('\n')).toContain('도구: Bash');
  expect(lines.join('\n')).toContain('2 messages');
  expect(lines.every((line) => Bun.stringWidth(line) <= 20)).toBe(true);
});

test('terminal codes cannot divide a stored secret before redaction', () => {
  const token = `sk-or-v1-${'d'.repeat(64)}`;
  const stored = `${token.slice(0, 14)}\x1b[31m${token.slice(14)}`;
  const visible = safeLogText(stored);
  expect(visible).not.toContain(token);
  expect(visible).toContain('sk-or-v1-***');
});

test('OSC title terminators preserve following conversation text', () => {
  expect(safeLogText('\x1b]0;title\x1b\\첫 답변')).toBe('첫 답변');
  expect(safeLogText('\x1b]0;title\x07첫 답변')).toBe('첫 답변');
});

test('untrusted error text cannot move the status line', () => {
  expect(safeStatusText('실패\x1b[2J\n다음 줄')).toBe('실패 다음 줄');
});

test('live reply preview keeps first text visible, wraps and strips terminal controls', () => {
  const lines = streamReplyLines('첫 토큰과 이어지는 문장\n\x1b[2J둘째 줄', 12);
  expect(lines[0]).toContain('엘라누스:');
  expect(lines.join('')).toContain('첫 토큰');
  expect(lines.join('\n')).toContain('둘째 줄');
  expect(lines.join('\n')).not.toContain('\x1b');
  expect(lines.every((line) => Bun.stringWidth(line) <= 12)).toBe(true);
});

test('wheel scrolls the log a few lines per notch and keeps following the bottom', () => {
  // scroll = lines above the bottom; 0 means "follow the newest line".
  expect(WHEEL_SCROLL_LINES).toBe(3);
  expect(wheelScroll(0, 'up', 50)).toBe(3);
  expect(wheelScroll(3, 'up', 50)).toBe(6);
  expect(wheelScroll(48, 'up', 50)).toBe(50);
  expect(wheelScroll(6, 'down', 50)).toBe(3);
  expect(wheelScroll(2, 'down', 50)).toBe(0);
  expect(wheelScroll(0, 'down', 50)).toBe(0);
  // A history shorter than the body has nothing to scroll.
  expect(wheelScroll(0, 'up', 0)).toBe(0);
  expect(wheelScroll(0, 'up', -4)).toBe(0);
});
