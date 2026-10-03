import { expect, test } from 'bun:test';
import { nextDropOverlay, type DropOverlayState } from './drop-overlay';

const hidden: DropOverlayState = { visible: false, depth: 0 };

test('file drag appears and nested enter/leave pairs do not flicker', () => {
  const entered = nextDropOverlay(hidden, 'enter', true);
  expect(entered).toEqual({ visible: true, depth: 1 });
  const child = nextDropOverlay(entered, 'enter', true);
  expect(child).toEqual({ visible: true, depth: 2 });
  expect(nextDropOverlay(child, 'leave', true)).toEqual(entered);
  expect(nextDropOverlay(entered, 'leave', true)).toEqual(hidden);
  expect(nextDropOverlay(hidden, 'leave', true)).toEqual(hidden);
});

test('drop and dragend reset depth even inside a child', () => {
  const nested = nextDropOverlay(nextDropOverlay(hidden, 'enter', true), 'enter', true);
  expect(nextDropOverlay(nested, 'drop', true)).toEqual(hidden);
  expect(nextDropOverlay(nested, 'end', true)).toEqual(hidden);
});

test('text and link drags never show an attachment overlay', () => {
  for (const event of ['enter', 'leave', 'drop', 'end'] as const) {
    expect(nextDropOverlay(hidden, event, false)).toEqual(hidden);
  }
  expect(nextDropOverlay({ visible: true, depth: 2 }, 'enter', false)).toEqual(hidden);
});
