// AUTOQ-ONE (0.2.16): seat goals go through one queue — the harness queue. The second queue
// #24057 added (`src/launch-head/seat-goal-queue.ts` · sqlite `seat_goals`) had no callers and is gone.
import { expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = join(import.meta.dir, '..', '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.ts$/.test(name) && !/\.test\.ts$|\.fixture\.ts$/.test(name) ? [path] : [];
  });
}

test('no second seat goal queue store exists outside the harness queue', () => {
  const offenders = sourceFiles(join(root, 'src'))
    .filter((path) => /CREATE TABLE[^`]*\bseat_goals?\b|seat-goal-queue/.test(readFileSync(path, 'utf8')))
    .map((path) => relative(root, path));
  expect(offenders).toEqual([]);
});

test('the harness queue is the seat goal queue', () => {
  const queue = readFileSync(join(root, 'src/harness/harness-queue.ts'), 'utf8');
  expect(queue).toContain('export async function addHarnessQueue(');
  expect(queue).toContain("join(root, 'harness', 'queue.json')");
});
