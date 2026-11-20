/**
 * CODEX-OAUTH-IN-VAULT (0.3.30 P0) — codex 주인 자격 금고 항목 식별 상수(§3.1 메타 칸).
 * 봉인(쓰기)·lease/mirror 읽기 배선은 PR-2 — 이 모듈은 상수·조합 함수만(부작용 0).
 */

export const CODEX_VAULT_ITEM_PREFIX = 'oauth:codex';

export const CODEX_VAULT_ITEM_KIND = 'oauth-refresh-owner';

export const CODEX_VAULT_ITEM_TRANSFER = 'mirror-lease';

export const CODEX_VAULT_ITEM_OWNER_HOST = 'mshq';

export function codexVaultItemId(account: string): string {
  return `${CODEX_VAULT_ITEM_PREFIX}:${account}`;
}
