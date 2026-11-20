import { describe, expect, test } from 'bun:test';
import { CODEX_VAULT_ITEM_PREFIX, codexVaultItemId } from '../secret/codex-vault-items.js';
import { isMovableVaultSecretId, movableVaultSecretIds } from './secret-move-vault-slots.js';

describe('secret-move-vault-slots (CRED-MOVE-SEALED · TC #94493)', () => {
  test('codex vault 항목은 이동 가능 — codexVaultItemId 조합 그대로 판정', () => {
    const id = codexVaultItemId('owner-main');
    expect(id).toBe(`${CODEX_VAULT_ITEM_PREFIX}:owner-main`);
    expect(isMovableVaultSecretId(id)).toBe(true);
  });

  test('static api-key 슬롯은 이 헬퍼 영역 밖(카탈로그 필터 담당 · 중복 판정 없음)', () => {
    expect(isMovableVaultSecretId('openai-api')).toBe(false);
    expect(isMovableVaultSecretId('openai-api/OPENAI_API_KEY')).toBe(false);
  });

  test('cred: 회전 슬롯·무관 id 제외', () => {
    expect(isMovableVaultSecretId('cred:rotating-login')).toBe(false);
    expect(isMovableVaultSecretId('random-id')).toBe(false);
    expect(isMovableVaultSecretId('')).toBe(false);
  });

  test('접두만 같고 계정이 빈 불완전 항목은 제외(fail-closed)', () => {
    expect(isMovableVaultSecretId(`${CODEX_VAULT_ITEM_PREFIX}:`)).toBe(false);
    expect(isMovableVaultSecretId(CODEX_VAULT_ITEM_PREFIX)).toBe(false);
  });

  test('전체 목록에서 vault 항목만 순서 보존해 걸러냄', () => {
    const rows = [
      'openai-api',
      codexVaultItemId('owner-main'),
      'cred:x',
      codexVaultItemId('backup-1'),
      'zzz',
    ];
    expect(movableVaultSecretIds(rows)).toEqual([
      `${CODEX_VAULT_ITEM_PREFIX}:owner-main`,
      `${CODEX_VAULT_ITEM_PREFIX}:backup-1`,
    ]);
  });
});
