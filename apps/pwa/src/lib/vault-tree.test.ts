import { describe, expect, test } from 'bun:test';
import { VAULT_TREE_KEY, collapseTreeOnOpen, readVaultTreeOpen, writeVaultTreeOpen } from './vault-tree';

function memory(): Storage {
  const map = new Map<string, string>();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => { map.set(k, v); } } as Storage;
}

describe('vault tree collapse', () => {
  test('defaults to open and remembers the choice per device', () => {
    const storage = memory();
    expect(readVaultTreeOpen(storage)).toBe(true);
    writeVaultTreeOpen(storage, false);
    expect(storage.getItem(VAULT_TREE_KEY)).toBe('0');
    expect(readVaultTreeOpen(storage)).toBe(false);
    writeVaultTreeOpen(storage, true);
    expect(readVaultTreeOpen(storage)).toBe(true);
  });

  test('unreadable storage falls back to open without throwing', () => {
    const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } } as unknown as Storage;
    expect(readVaultTreeOpen(broken)).toBe(true);
    expect(() => writeVaultTreeOpen(broken, false)).not.toThrow();
    expect(readVaultTreeOpen(null)).toBe(true);
  });

  test('opening a note collapses the tree only on narrow screens (phone · folded fold)', () => {
    expect(collapseTreeOnOpen(375)).toBe(true);
    expect(collapseTreeOnOpen(475)).toBe(true);
    expect(collapseTreeOnOpen(767)).toBe(true);
    expect(collapseTreeOnOpen(768)).toBe(false);
    expect(collapseTreeOnOpen(932)).toBe(false);
    expect(collapseTreeOnOpen(1440)).toBe(false);
  });
});
