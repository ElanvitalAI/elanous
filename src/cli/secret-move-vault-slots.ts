/**
 * CRED-MOVE-SEALED (0.3.30 P0 · TC #94493) — sealed 이동 대상 vault 항목 판별(순수 함수 · 부작용 0).
 *
 * #38855(CODEX-OAUTH-IN-VAULT)가 정의한 codex 주인 자격 vault 항목(`oauth:codex:<account>`,
 * src/secret/codex-vault-items.ts)을 `secret move` 공개키 봉투(export/import)와
 * `secret backup` 클라이언트 암호화 봉투(push/restore)가 기본 동작으로 포함하도록 하는
 * 판별·조합 함수. 값의 평문 경로(파일·stdout·argv)는 일절 만들지 않는다 — 봉투만.
 * 계정 이름이 빈 불완전 항목은 제외(fail-closed).
 *
 * 슬라이스: 이 모듈 = 슬라이스1(판별 상수 결합). sealed-move 배선 = 슬라이스2,
 * backup 커버리지 배선 = ELN-VAULT-CLOUD-SYNC. 옵션·깃발 신설 없음(기본 동작만).
 */
import { CODEX_VAULT_ITEM_PREFIX } from '../secret/codex-vault-items.js';

export function isMovableVaultSecretId(id: string): boolean {
  if (!id.startsWith(`${CODEX_VAULT_ITEM_PREFIX}:`)) return false;
  return id.slice(CODEX_VAULT_ITEM_PREFIX.length + 1).length > 0;
}

export function movableVaultSecretIds(allIds: readonly string[]): string[] {
  return allIds.filter(isMovableVaultSecretId);
}
