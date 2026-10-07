import { expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

// 10-06 live check: the production daemon runs from the installed package, and the editor's «+ New → Template»
// answered «No templates available» because package.json `files` never listed samples/workflows/templates/.
// Ask npm itself what the package carries — a files-list rule written in the test could agree with a wrong list.
setDefaultTimeout(60_000);

const root = resolve(import.meta.dir, '..');

test('the npm package carries every workflow template the repository has', () => {
  const expected = readdirSync(join(root, 'samples', 'workflows', 'templates'))
    .filter((name) => name.endsWith('.yaml'))
    .map((name) => `samples/workflows/templates/${name}`)
    .sort();
  expect(expected.length).toBeGreaterThan(0);
  const result = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8' });
  expect(result.status).toBe(0);
  const packed = (JSON.parse(result.stdout) as Array<{ files: Array<{ path: string }> }>)[0]!.files.map((file) => file.path);
  expect(packed.filter((path) => path.startsWith('samples/workflows/templates/')).sort()).toEqual(expected);
});
