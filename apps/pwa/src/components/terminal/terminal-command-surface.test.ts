import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'bun:test';

const src = fileURLToPath(new URL('../..', import.meta.url));
const forbidden = [
  ['Terminal', 'Repl'].join(''),
  ['dock', 'history', 'mirror'].join('-'),
  ['repl', 'Open'].join(''),
];

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() ? [path] : [];
  });
}

test('the PWA source, including tests, has no references to the retired command strip or history mirror', () => {
  const matches = sourceFiles(src).flatMap((path) => {
    const name = relative(src, path);
    const text = readFileSync(path, 'utf8');
    return forbidden.flatMap((token) =>
      name.includes(token) || text.includes(token) ? [`${name}: ${token}`] : [],
    );
  });
  expect(matches).toEqual([]);
});
