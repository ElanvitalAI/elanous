import { describe, expect, test } from 'bun:test';
import { nextChatScrollOffset } from './log-scroll-key.js';

describe('nextChatScrollOffset', () => {
  test('pageup leaves the tail by a page', () => {
    expect(nextChatScrollOffset(-1, 'pageup', 8, 20)).toBe(12);
  });

  test('repeated pageup stops at maxOffset on the upper bound', () => {
    const first = nextChatScrollOffset(-1, 'pageup', 8, 20);
    const second = nextChatScrollOffset(first, 'pageup', 8, 20);
    expect(second).toBe(4);
    expect(nextChatScrollOffset(second, 'pageup', 8, 20)).toBe(0);
    expect(nextChatScrollOffset(0, 'pageup', 8, 20)).toBe(0);
  });

  test('pagedown returns to tail when it reaches the bottom', () => {
    expect(nextChatScrollOffset(0, 'pagedown', 8, 20)).toBe(8);
    expect(nextChatScrollOffset(8, 'pagedown', 8, 20)).toBe(16);
    expect(nextChatScrollOffset(16, 'pagedown', 8, 20)).toBe(-1);
    expect(nextChatScrollOffset(-1, 'pagedown', 8, 20)).toBe(-1);
  });

  test('no scrollable lines keeps the tail pinned', () => {
    expect(nextChatScrollOffset(-1, 'pageup', 8, 0)).toBe(-1);
    expect(nextChatScrollOffset(-1, 'pagedown', 8, 0)).toBe(-1);
  });
});
