import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setUserConfigOverlay } from '../user-config.js';
import { _resetObsidianCacheForTests, resolveObsidianRoot } from './fs-roots.js';

const roots: string[] = [];
const vault = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'vault-'));
  mkdirSync(join(d, '.obsidian'));
  roots.push(d);
  return d;
};
const useVault = (v: string | undefined) =>
  setUserConfigOverlay((c) => ({ ...c, obsidian: { ...c.obsidian, vault: v as string } }));

afterEach(() => {
  setUserConfigOverlay(null);
  _resetObsidianCacheForTests();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe('resolveObsidianRoot cache', () => {
  test('a different existing vault in config is picked up without a restart (terminal path · 09-28)', () => {
    const a = vault();
    const b = vault();
    useVault(a);
    expect(resolveObsidianRoot().root).toBe(a);
    useVault(b);
    expect(resolveObsidianRoot().root).toBe(b);
  });

  test('a wiped or missing config vault keeps the cached one (running daemon is not stranded)', () => {
    const a = vault();
    useVault(a);
    expect(resolveObsidianRoot().root).toBe(a);
    useVault(undefined);
    expect(resolveObsidianRoot().root).toBe(a);
    useVault(join(a, 'no-such-folder'));
    expect(resolveObsidianRoot().root).toBe(a);
  });
});
