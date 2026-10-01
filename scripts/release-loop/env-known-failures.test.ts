import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadEnvKnownFailures, splitKnownEnv } from './env-known-failures';

const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const fixture = () => { const root = mkdtempSync(join(tmpdir(), 'known-env-')); scratch.push(root); mkdirSync(join(root, 'test')); return root; };

test('loads exactly the 172 seed identities and reasons without adding entries', async () => {
  const root = resolve(import.meta.dir, '../..');
  const source = await Bun.file(join(root, 'docs/measurements/env-known-failures-seed-2026-10-01.json')).json();
  const list = await Bun.file(join(root, 'test/env-known-failures.json')).json();
  expect(list).toEqual({ env: source.env, measuredAt: source.measuredAt, tests: source.tests });
  const known = loadEnvKnownFailures(root);
  expect(known.size).toBe(172);
  expect(known.has(source.tests[0].id)).toBe(true);
  expect(splitKnownEnv([source.tests[0].id, 'src/unlisted.test.ts > new'], known)).toEqual({
    counted: ['src/unlisted.test.ts > new'], knownEnv: [source.tests[0].id],
  });
});

test('missing list returns an empty set', () => {
  expect(loadEnvKnownFailures(fixture()).size).toBe(0);
});

test('invalid JSON, metadata, test ids, reasons and duplicates fail closed', () => {
  const root = fixture();
  const path = join(root, 'test/env-known-failures.json');
  const valid = { env: 'linux-pod', measuredAt: '2026-10-01', tests: [{ id: 'src/a.test.ts > A', reason: 'mac passes' }] };
  for (const value of ['{', JSON.stringify({ ...valid, env: 'macos' }), JSON.stringify({ ...valid, tests: [{ id: 'src/a.test.ts', reason: 'mac passes' }] }),
    JSON.stringify({ ...valid, tests: [{ id: 'src/a.test.ts > A', reason: '' }] }),
    JSON.stringify({ ...valid, tests: [valid.tests[0], valid.tests[0]] })]) {
    writeFileSync(path, value);
    expect(() => loadEnvKnownFailures(root)).toThrow('invalid environment known failures');
  }
});
