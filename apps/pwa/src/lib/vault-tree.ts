// Vault 폴더 트리 접기 (대표 2026-10-02 11:3x «본문을 크게 보고 싶은데 사이드에 폴더가 너무 크게 나온다»)
//
// - 접힘 상태는 기기마다 기억한다(localStorage · 못 읽으면 펼침).
// - 폭이 md(768) 미만(폰·폴드 접힘)에서 노트를 열면 트리를 접어 본문을 화면 전체로 보인다.

export const VAULT_TREE_KEY = 'elanous.pwa.vaultTreeOpen';
export const VAULT_TREE_NARROW_MAX = 767;

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export function readVaultTreeOpen(storage: StorageLike | null | undefined): boolean {
  try { return storage?.getItem(VAULT_TREE_KEY) !== '0'; } catch { return true; }
}

export function writeVaultTreeOpen(storage: StorageLike | null | undefined, open: boolean): void {
  try { storage?.setItem(VAULT_TREE_KEY, open ? '1' : '0'); } catch { /* 기억 못 해도 화면은 그대로 */ }
}

/** 노트를 연 뒤 트리를 접어야 하나 — 좁은 화면에서만(넓은 화면은 사람이 고른 상태를 지킨다). */
export function collapseTreeOnOpen(viewportWidth: number): boolean {
  return viewportWidth <= VAULT_TREE_NARROW_MAX;
}
