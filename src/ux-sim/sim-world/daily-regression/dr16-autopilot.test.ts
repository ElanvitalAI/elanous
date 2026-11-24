import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dr16 } from './dr16-autopilot.js';

const root = mkdtempSync(join(tmpdir(), 'dr16-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test('DR16 session autopilot scenario passes in a fresh universe', async () => {
  expect(await dr16.run({ universeRoot: root, note: () => {} })).toEqual({ ok: true });
});
