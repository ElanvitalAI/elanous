/**
 * DRAFT-NOT-ARCHIVE (RFC-draft-pr-accumulation-root-fix R1 · 첫 조각)
 *
 * S: 멈춘 런은 산출을 draft PR 로 남겼다 — PR 이 «실패 보관소»가 되어 열린 PR 이 200 을 넘고 겹침 검사가 눈이 멀었다.
 * C: 닫힌 147건 중 사람이 실제로 봐야 했던 것은 «주인 자리» 47건뿐이었다.
 * Q: 어느 멈춤이 PR 을 열 자격이 있나?
 * A: 사람 판단이 필요한 멈춤(needs-owner)만. 나머지(harvestable)는 수확 가지 `salvage/<run>/<leaf>` ⊕ 런 원장의 «사유 · 다음 수»로 남긴다.
 *    `tools.selfImplement.draftOnStop` = 'always'(기본 · 종전) | 'needs-owner-only'.
 */
export type DraftOnStopMode = 'needs-owner-only' | 'always';
export const DRAFT_ON_STOP_MODES = ['needs-owner-only', 'always'] as const satisfies readonly DraftOnStopMode[];
export const DEFAULT_DRAFT_ON_STOP: DraftOnStopMode = 'always';

export function parseDraftOnStopMode(raw: unknown): { mode: DraftOnStopMode; invalid: boolean } {
  if (raw === undefined) return { mode: DEFAULT_DRAFT_ON_STOP, invalid: false };
  if (typeof raw === 'string' && (DRAFT_ON_STOP_MODES as readonly string[]).includes(raw)) return { mode: raw as DraftOnStopMode, invalid: false };
  return { mode: DEFAULT_DRAFT_ON_STOP, invalid: true };
}
