import { expect, test } from 'bun:test';
import { added } from './index.js';
test('runtime export is added through export-star', () => expect(added).toBe(true));
