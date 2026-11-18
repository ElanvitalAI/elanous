import { expect, test } from 'bun:test';
import { QUEUE_NOTICE_NOTE_PREFIX, stripQueueModelContext, stripQueueNoticeContext, withQueueNoticeContext } from './interjection.js';

test('mf1 #38102 — the notice source head rides in front for the model and strips back to the body', () => {
  const wrapped = withQueueNoticeContext('OP 우편 3건 도착', 'seat-mail');
  expect(wrapped).toBe('[notice · seat-mail]\n\nOP 우편 3건 도착');
  expect(stripQueueNoticeContext(wrapped)).toBe('OP 우편 3건 도착');
  expect(stripQueueModelContext(wrapped)).toBe('OP 우편 3건 도착');
});

test('mf1 #38102 — headless text and a multi-line head stay untouched', () => {
  expect(stripQueueNoticeContext('그냥 사람 문장')).toBe('그냥 사람 문장');
  const twoLines = `${QUEUE_NOTICE_NOTE_PREFIX}seat-mail]\nsecond\n\nbody`;
  expect(stripQueueNoticeContext(twoLines)).toBe(twoLines);
});
