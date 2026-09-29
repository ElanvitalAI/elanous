import { expect, test } from 'bun:test';
import { envLiteral } from './env-literal.js';

test('partial env literal keeps the same object without merging ambient keys', () => {
  const o = { CODEX_HOME: '/x' };
  const e = envLiteral(o);
  expect(e).toBe(o);
  expect(Object.keys(e)).toEqual(['CODEX_HOME']);
});
