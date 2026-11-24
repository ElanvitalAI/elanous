// TUI-ANSWER-VANISH-ON-TOOLCALL (stale steer marker) — literal expectations, independent of product strings.
import { expect, test } from 'bun:test';
import { englishFooterText } from '../chat/status-line.js';
import { createNextTuiQueue } from './queue.js';
import { liveSteerStatus } from './steer-status.js';

const SENT = '조향 대기 1건 · 다음 도구 경계에 넣음 · Esc 취소';

test('steer queued → joined at the tool boundary → footer no longer says «steer pending»', () => {
  const queue = createNextTuiQueue({ log: () => {} });
  queue.enqueue('제가 요청을 하면 끝까지 확인을 해야죠.', 'steer-28');
  expect(queue.steerCount).toBe(1);
  expect(englishFooterText(liveSteerStatus(SENT, queue.steerCount, true).text)).toContain('1 steer pending');
  expect(queue.markSteered(['steer-28'])).toBe(1);
  const live = liveSteerStatus(SENT, queue.steerCount, true);
  expect(live.stale).toBe(true);
  expect(live.text).toBe('응답 중 · Esc 취소');
  expect(englishFooterText(live.text)).not.toContain('steer pending');
  expect(englishFooterText(live.text)).not.toContain('joins at next tool boundary');
});

test('a steer that left the queue after the turn (carried, recalled, idle) leaves no pending claim behind', () => {
  expect(liveSteerStatus(SENT, 0, false)).toEqual({ text: 'Enter 전송', stale: true });
});

test('the pending count follows the queue; unrelated statuses pass through untouched', () => {
  expect(liveSteerStatus('조향 대기 3건 · 다음 도구 경계에 넣음 · Esc 취소', 1, true))
    .toEqual({ text: '조향 대기 1건 · 다음 도구 경계에 넣음 · Esc 취소', stale: true });
  expect(liveSteerStatus(SENT, 1, true)).toEqual({ text: SENT, stale: false });
  expect(liveSteerStatus('도구 실행 · Esc 취소', 0, true)).toEqual({ text: '도구 실행 · Esc 취소', stale: false });
});
