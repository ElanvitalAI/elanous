import { expect, test } from 'bun:test';
import { saveSkipNotice } from './obsidian.js';

const NOTICE =
  '저장 안 됨 · OBSIDIAN_VAULT_ROOT 가 없다 · 고칠 한 줄: export OBSIDIAN_VAULT_ROOT=<vault 경로>';

test('no vault + target obsidian returns 저장 안 됨 three-part notice', () => {
  expect(saveSkipNotice('obsidian', null)).toBe(NOTICE);
});

test('vault present + target obsidian returns null', () => {
  expect(saveSkipNotice('obsidian', '/vault/path')).toBeNull();
});

test('target markdown returns null even without vault', () => {
  expect(saveSkipNotice('markdown', null)).toBeNull();
});
