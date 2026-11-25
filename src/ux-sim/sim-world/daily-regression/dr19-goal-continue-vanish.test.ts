import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dr19 } from './dr19-goal-continue-vanish.js';

const root = mkdtempSync(join(tmpdir(), 'dr19-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test('DR19 goal-continue + held flush keeps the shown answer (fresh universe)', async () => {
  expect(await dr19.run({ universeRoot: root, note: () => {} })).toEqual({ ok: true });
});
