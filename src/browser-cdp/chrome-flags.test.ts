import { expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = join(import.meta.dir, '..', '..');
function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* sources(path);
    else if (/\.(ts|mts|mjs|js)$/.test(name) && !/\.test\./.test(name)) yield path;
  }
}

test('every Chrome launch that sets --user-data-dir also disables the macOS keychain prompt', () => {
  const offenders: string[] = [];
  for (const dir of ['src', 'scripts']) {
    for (const file of sources(join(root, dir))) {
      const text = readFileSync(file, 'utf8');
      // Launch sites build the flag with a value (`--user-data-dir=${…}`); prose mentions do not.
      if (!/--user-data-dir=\$\{/.test(text)) continue;
      if (!/CHROME_NO_KEYCHAIN_FLAGS|--use-mock-keychain/.test(text)) offenders.push(relative(root, file));
    }
  }
  expect(offenders).toEqual([]);
});
