import { describe, expect, test } from 'bun:test';
import { assertVaultWriteAllowed, VaultWriteBlockedError } from './vault-write-guard.js';

const TMP = () => '/private/var/folders/xx/T';
const NONE = () => undefined;
describe('vault write guard — the vault stays the single knowledge source; the test universe only loses «write»', () => {
  test('prod universe writes anywhere (the real vault is its own)', () => {
    expect(() => assertVaultWriteAllowed('/Users/u/Obsidian/Vault/a.md', { instance: () => ({ kind: 'prod', root: '/Users/u/.elanous' }), tmp: TMP, testVault: NONE })).not.toThrow();
  });
  test('test universe cannot write into the real vault', () => {
    expect(() => assertVaultWriteAllowed('/Users/u/Obsidian/Vault/a.md', { instance: () => ({ kind: 'test', root: '/repo/.elanous-test' }), tmp: TMP, testVault: NONE })).toThrow(VaultWriteBlockedError);
  });
  test('test universe may write into its own root or an OS temp vault a test chose explicitly', () => {
    const inst = () => ({ kind: 'test', root: '/repo/.elanous-test' });
    expect(() => assertVaultWriteAllowed('/repo/.elanous-test/vault/a.md', { instance: inst, tmp: TMP, testVault: NONE })).not.toThrow();
    expect(() => assertVaultWriteAllowed('/private/var/folders/xx/T/v1/a.md', { instance: inst, tmp: TMP, testVault: NONE })).not.toThrow();
  });
  test('a sibling path that merely shares a prefix is not «inside»', () => {
    expect(() => assertVaultWriteAllowed('/repo/.elanous-test-evil/a.md', { instance: () => ({ kind: 'test', root: '/repo/.elanous-test' }), tmp: TMP, testVault: NONE })).toThrow(VaultWriteBlockedError);
  });
  test('a configured test vault (obsidian.testVault) is writable — the real vault stays blocked', () => {
    const inst = () => ({ kind: 'test', root: '/repo/.elanous-test' });
    const tv = () => '/Users/u/Obsidian/elantest';
    expect(() => assertVaultWriteAllowed('/Users/u/Obsidian/elantest/n/a.md', { instance: inst, tmp: TMP, testVault: tv })).not.toThrow();
    expect(() => assertVaultWriteAllowed('/Users/u/Obsidian/Vault/a.md', { instance: inst, tmp: TMP, testVault: tv })).toThrow(VaultWriteBlockedError);
    // 대조군: 시험 볼트가 없으면 같은 경로가 막힌다
    expect(() => assertVaultWriteAllowed('/Users/u/Obsidian/elantest/n/a.md', { instance: inst, tmp: TMP, testVault: NONE })).toThrow(VaultWriteBlockedError);
  });
});
