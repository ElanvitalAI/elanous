import { expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

// 10-06 live check: the production daemon runs from the installed package, and the editor's «+ New → Template»
// answered «No templates available» because package.json `files` never listed samples/workflows/templates/.
// Ask Bun's package packer what the repository would ship. The gate image has Bun,
// but does not necessarily have npm; a files-list rule copied into this test could
// agree with an incorrect package declaration.
setDefaultTimeout(60_000);

const root = resolve(import.meta.dir, '..');

test('the packaged files carry every workflow template the repository has', () => {
  const expected = readdirSync(join(root, 'samples', 'workflows', 'templates'))
    .filter((name) => name.endsWith('.yaml'))
    .map((name) => `samples/workflows/templates/${name}`)
    .sort();
  expect(expected.length).toBeGreaterThan(0);
  const result = spawnSync(process.execPath, ['pm', 'pack', '--dry-run', '--ignore-scripts'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  const packed = result.stdout
    .split('\n')
    .map((line) => /^packed\s+\S+\s+(samples\/workflows\/templates\/[^\s]+\.yaml)$/.exec(line)?.[1])
    .filter((path): path is string => path !== undefined)
    .sort();
  expect(packed).toEqual(expected);
});
