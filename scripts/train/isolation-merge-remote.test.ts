import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

test('remote isolation decision and identity contract runs under Python', () => {
  const result = spawnSync('python3', [join(import.meta.dir, 'test-isolation-merge-remote.py')], { encoding: 'utf8' });
  expect(result.status).toBe(0);
  expect(result.stderr).toContain('OK');
});
