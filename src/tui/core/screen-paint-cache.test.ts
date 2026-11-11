import { expect, test } from 'bun:test';
import { remoteFrameRows, ScreenPaintCache } from './screen-paint-cache.js';

test('splits ANSI PTY snapshots into visible rows and trims old rows when a frame shrinks', () => {
  expect(remoteFrameRows('\u001b[31mred line\u001b[0m\nsecond line\n', 20, 3)).toEqual([
    '\u001b[31mred line\u001b[0m', 'second line',
  ]);
  const cache = new ScreenPaintCache();
  cache.diff(['remote one', 'remote two', 'remote three', 'footer'], 80, 24);
  expect(cache.diff(['remote one changed', 'footer'], 80, 24)).toEqual({
    clear: false,
    changedRows: [{ row: 0, text: 'remote one changed' }, { row: 1, text: 'footer' }, { row: 2, text: '' }, { row: 3, text: '' }],
  });
});

test('external overlays repaint the full viewport without forcing a screen clear', () => {
  const cache = new ScreenPaintCache();
  expect(cache.diff(['main', 'prompt'], 80, 24)).toEqual({
    clear: true,
    changedRows: [{ row: 0, text: 'main' }, { row: 1, text: 'prompt' }],
  });
  // The modal may draw below the two logical lines, so invalidate all 24
  // terminal rows; the next frame repaints those cells without ESC[2J.
  cache.invalidate(24);
  const restored = cache.diff(['main', 'prompt'], 80, 24);
  expect(restored.clear).toBe(false);
  expect(restored.changedRows).toHaveLength(24);
  expect(restored.changedRows[23]).toEqual({ row: 23, text: '' });
  expect(cache.diff(['main restored', 'prompt'], 100, 24).clear).toBe(true);
});
