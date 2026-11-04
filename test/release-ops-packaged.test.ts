import { expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

// The installed release CLI loads packs/release-ops/policy.yaml before building its graph.
// Check Bun's actual package inventory so this cannot pass from a copied files-list rule alone.
setDefaultTimeout(60_000);

const root = resolve(import.meta.dir, '..');

function filesUnder(directory: string, relative = ''): string[] {
  return readdirSync(join(directory, relative), { withFileTypes: true }).flatMap((entry) => {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    return entry.isDirectory() ? filesUnder(directory, path) : [path];
  }).sort();
}

function packedReleaseOpsPaths(output: string): string[] {
  return output.split(/\r?\n/)
    .map((line) => /^packed\s+\S+\s+(packs\/release-ops\/.*)$/.exec(line)?.[1])
    .filter((path): path is string => path !== undefined)
    .sort();
}

test('the package inventory parser keeps file paths containing spaces', () => {
  expect(packedReleaseOpsPaths('packed 1KB packs/release-ops/future policy.yaml'))
    .toEqual(['packs/release-ops/future policy.yaml']);
});

test('the installed package carries every release-ops pack file', () => {
  const expected = filesUnder(join(root, 'packs', 'release-ops')).map((path) => `packs/release-ops/${path}`);
  expect(expected).toContain('packs/release-ops/policy.yaml');
  const result = spawnSync(process.execPath, ['pm', 'pack', '--dry-run', '--ignore-scripts'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(packedReleaseOpsPaths(result.stdout)).toEqual(expected);
});
