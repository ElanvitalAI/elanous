import { expect, test } from 'bun:test';
import { added } from './value.ts';
test('new export exists', () => expect(added()).toBe(true));
