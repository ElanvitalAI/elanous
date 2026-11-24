import { expect, test } from 'bun:test';
import type { SerializedMessage } from '../../session/index.js';
import { renderNextTuiLogFrame, wheelScroll } from './render.js';
import { anchorStickyScroll, stickyScrollHint, stickyScrollResetAllowed, type StickyScrollMemo } from './sticky-scroll.js';

// TUI-STICKY-SCROLLBACK (대표 11-24): expectations are literals, independent of the product's own helpers.

const plain = (row: string): string => row.replace(/\x1b\[[0-9;]*m/g, '');

function frameOf(activity: string[], scroll: number, messages: SerializedMessage[] = []) {
  // 12 rows = header 1 + footer 1 + prompt 1 → 9 transcript rows.
  return renderNextTuiLogFrame({ messages, columns: 60, rows: 12, header: ['header'], footer: ['footer'],
    promptLine: '❯ ', notices: [], activity, scroll, expandedToolIndexes: new Set<number>() });
}

const rowsUpTo = (count: number): string[] => Array.from({ length: count }, (_, index) => `row-${index + 1}`);

test('scrolled up 20 rows: a notice turn appending 5 rows keeps the same top row (scroll 25)', () => {
  const before = frameOf(rowsUpTo(100), 20);
  expect(before.historyRows).toBe(100);
  expect(plain(before.body[0]!)).toBe('row-72');
  const memo: StickyScrollMemo = { historyRows: 100, layout: 'session|60|chat|full', unseenRows: 0 };
  const anchored = anchorStickyScroll(20, memo, 105, 'session|60|chat|full');
  expect(anchored).toEqual({ scroll: 25, unseenRows: 5, delta: 5 });
  const after = frameOf(rowsUpTo(105), anchored.scroll);
  expect(after.scroll).toBe(25);
  expect(plain(after.body[0]!)).toBe('row-72');
  expect(stickyScrollHint(after.scroll, anchored.unseenRows)).toBe('↓ 5 new · End to jump');
});

test('rows going away below (activity cleared at turn end) keep the top row and never count as new', () => {
  const memo: StickyScrollMemo = { historyRows: 105, layout: 'k', unseenRows: 5 };
  expect(anchorStickyScroll(25, memo, 100, 'k')).toEqual({ scroll: 20, unseenRows: 0, delta: -5 });
  // Shrinking past the bottom lands on the bottom.
  expect(anchorStickyScroll(3, { historyRows: 110, layout: 'k', unseenRows: 0 }, 100, 'k')).toEqual({ scroll: 0, unseenRows: 0, delta: -10 });
});

test('at the bottom new rows simply show; a different layout (width/session) is not anchored', () => {
  expect(anchorStickyScroll(0, { historyRows: 100, layout: 'k', unseenRows: 0 }, 105, 'k')).toEqual({ scroll: 0, unseenRows: 0, delta: 0 });
  expect(anchorStickyScroll(20, { historyRows: 100, layout: 'a|60', unseenRows: 0 }, 140, 'a|80')).toEqual({ scroll: 20, unseenRows: 0, delta: 0 });
  expect(anchorStickyScroll(20, null, 100, 'k')).toEqual({ scroll: 20, unseenRows: 0, delta: 0 });
  expect(stickyScrollHint(0, 5)).toBe('');
  expect(stickyScrollHint(20, 0)).toBe('');
});

test('wheel-up to the top reaches the first message of a 300-message session', () => {
  const messages: SerializedMessage[] = Array.from({ length: 300 }, (_, index) => ({
    role: 'user' as const, content: `msg-${String(index + 1).padStart(3, '0')}`, ts: '2026-11-24T00:00:00Z' }));
  let frame = frameOf([], 0, messages);
  expect(frame.body.map(plain).join('\n')).toContain('msg-300');
  let guard = 0;
  while (guard++ < 10_000) {
    const next = wheelScroll(frame.scroll, 'up', frame.maxScroll);
    if (next === frame.scroll) break;
    frame = frameOf([], next, messages);
  }
  expect(frame.logWindow.start).toBe(0);
  expect(frame.scroll).toBe(frame.maxScroll);
  expect(frame.body.map(plain).join('\n')).toContain('msg-001');
  expect(frame.body.map(plain).join('\n')).not.toContain('msg-300');
});

test('only the person returns a scrolled view to the bottom: submit/End yes, a turn end no', () => {
  expect(stickyScrollResetAllowed('submit')).toBe(true);
  expect(stickyScrollResetAllowed('end-key')).toBe(true);
  expect(stickyScrollResetAllowed('session-switch')).toBe(true);
  expect(stickyScrollResetAllowed('compaction')).toBe(true);
  expect(stickyScrollResetAllowed('turn-end')).toBe(false);
  // After the submit reset (scroll 0) the person's own new rows show at the bottom.
  const bottom = frameOf(rowsUpTo(105), 0);
  expect(plain(bottom.body.at(-1)!)).toBe('row-105');
});
