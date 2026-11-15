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
  expect(nextFirstScreenLines({ ...empty, availableRows: 1 })).toEqual(['Ask anything']);
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

test('narrow welcome shows one complete hint and omits it if it cannot fit', () => {
  for (const width of [12, 20, 40, 42]) {
    expect(nextFirstScreenLines({ ...empty, width })).toEqual(['Ask anything']);
  }
  expect(nextFirstScreenLines({ ...empty, width: 8 })).toEqual([]);
});

test('wide welcome retains complete actions at the exact fit boundary', () => {
  const lines = nextFirstScreenLines({ ...empty, width: 43 });
  expect(lines).toHaveLength(3);
  expect(lines[0]).toBe('· Chat — ask for anything in plain language');
});

test('two available rows use the complete single-line hint instead of dropping the example', () => {
  expect(nextFirstScreenLines({ ...empty, availableRows: 2 })).toEqual(['Ask anything']);
});
