import { describe, expect, test } from 'bun:test';
import { shouldClear } from './terminal-clear';

describe('shouldClear', () => {
  test('does not clear for equal request numbers', () => {
    expect(shouldClear(0, 0)).toBe(false);
    expect(shouldClear(1, 1)).toBe(false);
  });

  test('clears when the request number increases from 0 to 1', () => {
    expect(shouldClear(0, 1)).toBe(true);
  });

  test('does not clear on the initial undefined to 0 transition', () => {
    expect(shouldClear(undefined, 0)).toBe(false);
  });
});
