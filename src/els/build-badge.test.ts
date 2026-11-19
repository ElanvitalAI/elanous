import { expect, test } from 'bun:test';
import { buildAge, desiredSha } from './build-badge.js';

const old = 'a'.repeat(40), desired = 'b'.repeat(40);
test('only known ancestors are older; missing or unrelated builds stay distinct', () => {
  expect(buildAge(old, desired, () => true)).toBe('older');
  expect(buildAge(old, desired, () => false)).toBe('different');
  expect(buildAge(old, desired, () => undefined)).toBe('unknown');
  expect(buildAge(undefined, desired, () => true)).toBe('unknown');
  expect(buildAge(old, undefined, () => true)).toBe('unknown');
  expect(buildAge(desired, desired, () => false)).toBe('current');
  expect(desiredSha('/no/such/desired.json')).toBeUndefined();
});
