import { expect, test } from 'bun:test';
import { added } from './value.ts';
test('re-exported runtime value exists', () => expect(added()).toBe(true));
