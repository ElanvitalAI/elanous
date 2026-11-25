import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dr17 } from './dr17-bulk-triage.js';

const root = mkdtempSync(join(tmpdir(), 'dr17-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test('DR17 bulk triage scenario passes in a fresh universe', async () => {
  expect(await dr17.run({ universeRoot: root, note: () => {} })).toEqual({ ok: true });
});
