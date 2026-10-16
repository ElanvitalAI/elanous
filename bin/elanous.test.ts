import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const entry = join(import.meta.dir, 'elanous.mjs');
const repo = join(import.meta.dir, '..');

function invoke(...args: string[]) {
  return spawnSync('bun', [entry, ...args], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 120_000,
  });
}

test('standalone version aliases return the same single line', () => {
  const long = invoke('--version');
  const short = invoke('-V');
  expect(long.status, long.stderr).toBe(0);
  expect(short.status, short.stderr).toBe(0);
  expect(short.stdout).toBe(long.stdout);
  expect(long.stdout.trim().split('\n')).toHaveLength(1);
});

test('other arguments still enter the regular CLI', () => {
  const result = invoke('--help');
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('Usage:');
});
