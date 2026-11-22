import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRecipeHighwater } from './run-shell-recipe-highwater.js';
const digest = 'a'.repeat(64);
import { readSignedRecipe } from './run-shell-signed-recipe.js';

test('recipe state follows the isolated state root instead of the production home', () => {
  const root = mkdtempSync(join(tmpdir(), 'recipe-isolation-'));
  const previous = process.env.ELANOUS_STATE_DIR;
  try {
    process.env.ELANOUS_STATE_DIR = root;
    const dir = join(root, 'runshell');
    mkdirSync(join(dir, 'recipes'), { recursive: true });
    writeFileSync(join(dir, 'recipe-highwater.json'), JSON.stringify({ schema: 2, epoch: 23, revocationStateSha256: digest }), { mode: 0o600 });
    writeFileSync(join(dir, 'recipes', 'example.json'), '{}', { mode: 0o600 });
    expect(readRecipeHighwater()).toEqual({ ok: true, epoch: 23, revocationStateSha256: digest });
    expect(() => readSignedRecipe('example')).toThrow('invalid recipe envelope');
  } finally {
    if (previous === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('highwater is persistent read-only finite positive safe integer state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'recipe-highwater-'));
  const path = join(dir, 'highwater.json');
  expect(readRecipeHighwater(path)).toEqual({ ok: false, reason: 'missing-highwater' });
  writeFileSync(path, JSON.stringify({ schema: 2, epoch: 42, revocationStateSha256: digest }), { mode: 0o600 });
  expect(readRecipeHighwater(path)).toEqual({ ok: true, epoch: 42, revocationStateSha256: digest });
  for (const epoch of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, null]) {
    writeFileSync(path, JSON.stringify({ schema: 2, epoch, revocationStateSha256: digest }));
    expect(readRecipeHighwater(path)).toEqual({ ok: false, reason: 'invalid-highwater' });
  }
  writeFileSync(path, JSON.stringify({ schema: 1, epoch: 42 }));
  expect(readRecipeHighwater(path)).toEqual({ ok: false, reason: 'invalid-highwater' });
  chmodSync(path, 0o644);
  expect(readRecipeHighwater(path)).toEqual({ ok: false, reason: 'unsafe-highwater' });
  const link = join(dir, 'link'); symlinkSync(path, link);
  expect(readRecipeHighwater(link).ok).toBe(false);
});
