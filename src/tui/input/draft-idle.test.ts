import { describe, expect, test } from 'bun:test';
import { createDraftKeyClock, isIdleDraft } from './draft-idle.js';

describe('idle draft', () => {
  test('unknown key time starts a fresh observation window, resetting on changes and clock rollback', () => {
    const clock = createDraftKeyClock();
    expect(clock('restored', 0, 1_000)).toBe(1_000);
    expect(isIdleDraft('restored', clock('restored', 0, 120_999), 120_999)).toBe(false);
    expect(isIdleDraft('restored', clock('restored', 0, 121_000), 121_000)).toBe(true);
    expect(clock('changed', 0, 122_000)).toBe(122_000);
    expect(clock('changed', 0, 2_000)).toBe(2_000);
    expect(clock('changed', 1_900, 2_000)).toBe(1_900);
    expect(clock('changed', 0, 3_000)).toBe(3_000);
    expect(clock('', 0, 4_000)).toBe(0);
    expect(clock('changed', 0, 5_000)).toBe(5_000);
    expect(clock('changed', NaN, 5_000)).toBeNaN();
  });
  test('requires a nonempty draft and two minutes since a known human key', () => {
    expect(isIdleDraft('draft', 1_000, 120_999)).toBe(false);
    expect(isIdleDraft('draft', 1_000, 121_000)).toBe(true);
    expect(isIdleDraft('', 1_000, 121_000)).toBe(false);
    expect(isIdleDraft('draft', 0, 121_000)).toBe(false);
    expect(isIdleDraft('draft', 122_000, 121_000)).toBe(false);
    expect(isIdleDraft('draft', NaN, 121_000)).toBe(false);
  });

  test('rejects invalid clocks and idle windows rather than yielding a draft', () => {
    expect(isIdleDraft('draft', 1_000, NaN)).toBe(false);
    expect(isIdleDraft('draft', 1_000, Infinity)).toBe(false);
    expect(isIdleDraft('draft', Infinity, 121_000)).toBe(false);
    expect(isIdleDraft('draft', 1_000, 121_000, -1)).toBe(false);
    expect(isIdleDraft('draft', 1_000, 121_000, NaN)).toBe(false);
  });

  test('treats whitespace as an unsent draft and honors the exact custom threshold', () => {
    expect(isIdleDraft(' \n', 1_000, 1_499, 500)).toBe(false);
    expect(isIdleDraft(' \n', 1_000, 1_500, 500)).toBe(true);
  });
});
