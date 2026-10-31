import { expect, test } from 'bun:test';
import { resolveChildAllowance } from './arg-allowance.js';

test('a child allowance within the parent remainder is unchanged', () => {
  expect(resolveChildAllowance(4, 7)).toEqual({ kind: 'run', requested: 4, granted: 4, clamped: false });
});

test('a child allowance above the parent remainder is clamped before execution', () => {
  expect(resolveChildAllowance(8, 3)).toEqual({ kind: 'run', requested: 8, granted: 3, clamped: true });
});

test('zero parent remainder rejects before execution for needs-human routing', () => {
  expect(resolveChildAllowance(2, 0)).toEqual({ kind: 'needs-human', requested: 2, remaining: 0 });
});

test('invalid allowances are rejected', () => {
  expect(() => resolveChildAllowance(0, 3)).toThrow('requested allowance');
  expect(() => resolveChildAllowance(2, -1)).toThrow('parent remaining allowance');
});
