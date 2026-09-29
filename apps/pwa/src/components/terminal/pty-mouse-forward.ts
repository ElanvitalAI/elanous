// 벽·라이브 화면에서 사람이 takeover 했을 때 마우스를 PTY 로 넘긴다(서버 `input-mouse` · 🅢 #21609 SGR 인코더).
// 화면 좌표 → 1 기반 셀 좌표. 앱이 마우스 모드가 아니면 서버가 거절한다 — 그건 «오류»가 아니라 «그 앱은 마우스를 안 받는다»다.

export interface CellPoint { x: number; y: number }

/** 픽셀 → 셀(1 기반 · 가장자리로 자른다). 화면 크기를 모르면 null. */
export function cellFromPoint(px: number, py: number, rect: { left: number; top: number; width: number; height: number }, cols: number, rows: number): CellPoint | null {
  if (!(rect.width > 0) || !(rect.height > 0) || cols < 1 || rows < 1) return null;
  const x = Math.floor(((px - rect.left) / rect.width) * cols) + 1;
  const y = Math.floor(((py - rect.top) / rect.height) * rows) + 1;
  return { x: Math.min(cols, Math.max(1, x)), y: Math.min(rows, Math.max(1, y)) };
}

/** 마우스 버튼 번호(MouseEvent.button) → 서버 이름. 뒤로·앞으로 버튼은 넘기지 않는다. */
export function mouseButtonName(button: number): 'left' | 'middle' | 'right' | null {
  return button === 0 ? 'left' : button === 1 ? 'middle' : button === 2 ? 'right' : null;
}

/** 서버 거절 사유가 «앱이 마우스 모드가 아님»인가. */
export function isMouseModeOff(reason: string | undefined): boolean {
  return !!reason && /mouse mode is off|\?1006/i.test(reason);
}
