import { expect, test } from 'bun:test';
import { mergeLayers } from './layers.js';

test('arrays remain replacement values even when their prototype resembles a plain object', () => {
  const base = Object.setPrototypeOf([1], Object.prototype);
  const override = Object.setPrototypeOf([2], Object.prototype);
  const merged = mergeLayers([{ source: 'defaults', value: { items: base } }, { source: 'env', value: { items: override } }]);

  expect(Array.isArray(merged.items)).toBe(true);
  expect(merged.items).toBe(override);
});
