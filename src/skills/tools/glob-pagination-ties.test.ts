import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchGlob } from './glob.js';

const root = mkdtempSync(join(tmpdir(), 'glob-page-ties-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test('Glob orders equal mtimes by path across offset pages', async () => {
  const names = ['z.txt', 'a.txt', 'm.txt'];
  const timestamp = new Date('2020-01-01T00:00:00Z');
  for (const name of names) {
    const file = join(root, name);
    writeFileSync(file, 'fixture');
    utimesSync(file, timestamp, timestamp);
  }
  const first = await dispatchGlob({ path: root, pattern: '*.txt', head_limit: 2 });
  const second = await dispatchGlob({ path: root, pattern: '*.txt', head_limit: 2, offset: 2 });
  expect(first.numFiles).toBe(3);
  expect(first.numShown).toBe(2);
  expect(first.truncated).toBe(true);
  expect(first.output.indexOf(join(root, 'a.txt'))).toBeLessThan(first.output.indexOf(join(root, 'm.txt')));
  expect(first.output).not.toContain(join(root, 'z.txt'));
  expect(second.output).toContain(join(root, 'z.txt'));
  expect(second.numShown).toBe(1);
  expect(second.truncated).toBe(false);
});
