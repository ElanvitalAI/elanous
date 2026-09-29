// 폰에서 손가락으로 터미널 스크롤백을 올린다 — xterm 6 은 터치 끌기로 스크롤하지 않는다
// (2026-09-28 실측: 휠은 L2980→L2951 로 올라가는데 터치 제스처는 390·1280 모두 0줄).
// ⛔ 이미 스스로 스크롤된 만큼은 빼고 «모자란 만큼만» 민다 — 네이티브 스크롤이 도는 환경에서 두 번 밀지 않는다.

export interface TouchScrollInput {
  /** 손가락이 닿은 y(px). */
  readonly startY: number;
  /** 지금 손가락 y(px). 아래로 끌면 커진다 = 과거(위)를 본다. */
  readonly currentY: number;
  /** 한 줄 높이(px). */
  readonly cellHeight: number;
  /** 닿았을 때 뷰포트 첫 줄(buffer.viewportY). */
  readonly startViewportY: number;
  /** 지금 뷰포트 첫 줄. */
  readonly currentViewportY: number;
}

/** 이번에 `term.scrollLines(n)` 에 줄 n. 음수 = 위로(과거). 0 = 할 일 없음. */
export function touchScrollLines(input: TouchScrollInput): number {
  if (!(input.cellHeight > 0)) return 0;
  const wanted = -Math.trunc((input.currentY - input.startY) / input.cellHeight);
  const already = input.currentViewportY - input.startViewportY;
  const lines = wanted - already;
  return lines === 0 ? 0 : lines; // -0 을 0 으로
}
