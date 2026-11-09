import { describe, expect, test } from 'bun:test';
import { asRecord, isFiniteNumber, isNonEmptyString, isObject, isPlainObject, isRecord, isStringArray } from './guards.js';

describe('shared input guards', () => {
  test('record and object guards reject null and arrays', () => {
    expect(isRecord({ value: 1 })).toBe(true);
    expect(isObject({ value: 1 })).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord([])).toBe(false);
  });

  test('record conversion preserves fallback, array, and copy behavior', () => {
    expect(asRecord(null)).toBeNull();
    expect(asRecord(null, { fallback: 'undefined' })).toBeUndefined();
    expect(asRecord(null, { fallback: 'empty' })).toEqual({});
    expect(asRecord([], { allowArrays: true, fallback: 'null' }) as unknown).toEqual([]);
    const input = { value: 1 };
    expect(asRecord(input, { fallback: 'undefined', clone: true })).not.toBe(input);
  });

  test('plain object guard can preserve strict prototype behavior', () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject(Object.create(null))).toBe(true);
    expect(isPlainObject(Object.create(null), false)).toBe(false);
    expect(isPlainObject(new Date())).toBe(false);
    const arrayWithNullPrototype = Object.setPrototypeOf([], null);
    expect(isPlainObject(arrayWithNullPrototype)).toBe(false);
    expect(isPlainObject(arrayWithNullPrototype, true, false)).toBe(true);
    expect(isPlainObject(arrayWithNullPrototype, true, true)).toBe(false);
    const arrayWithObjectPrototype = Object.setPrototypeOf([], Object.prototype);
    expect(isPlainObject(arrayWithObjectPrototype)).toBe(false);
    expect(isPlainObject(arrayWithObjectPrototype, true, false)).toBe(true);
  });

  test('scalar and list guards preserve their boundary semantics', () => {
    expect(isNonEmptyString('  ')).toBe(false);
    expect(isNonEmptyString('  ', false)).toBe(true);
    expect(isFiniteNumber(3)).toBe(true);
    expect(isFiniteNumber(Number.NaN)).toBe(false);
    expect(isStringArray(['a', 'b'])).toBe(true);
    expect(isStringArray(['a', 2])).toBe(false);
  });
});
