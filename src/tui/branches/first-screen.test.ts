import { expect, test } from 'bun:test';
import { nextFirstScreenLines } from './first-screen.js';

const empty = {
  width: 80,
  availableRows: 12,
  hasMessages: false,
  hasActivity: false,
  hasNotices: false,
  hasDraft: false,
  busy: false,
};

test('empty next TUI shows only usable classic guidance and respects screen space', () => {
  const lines = nextFirstScreenLines(empty);
  expect(lines.some((line) => line.includes('/help'))).toBe(true);
  expect(lines.some((line) => line.includes('/run-skill'))).toBe(false);
  expect(nextFirstScreenLines({ ...empty, availableRows: 1 })).toEqual(lines.slice(0, 1));
  expect(nextFirstScreenLines({ ...empty, width: 20 }).every((line) => Bun.stringWidth(line) <= 20)).toBe(true);
});

test('guidance leaves the screen when the user starts working', () => {
  for (const state of [
    { hasMessages: true }, { hasActivity: true }, { hasNotices: true },
    { hasDraft: true }, { busy: true }, { availableRows: 0 },
  ]) {
    expect(nextFirstScreenLines({ ...empty, ...state })).toEqual([]);
  }
});

test('narrow widths never reveal a clipped classic-only skill action', () => {
  for (const width of [8, 12, 20]) {
    const lines = nextFirstScreenLines({ ...empty, width });
    expect(lines).toHaveLength(3);
    expect(lines.some((line) => line.includes('스킬') || line.includes('/run-skill'))).toBe(false);
    expect(lines.every((line) => Bun.stringWidth(line) <= width)).toBe(true);
  }
});
