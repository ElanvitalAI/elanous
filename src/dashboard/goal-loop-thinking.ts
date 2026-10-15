// 대시보드 /goal 반복의 진행 표시 손잡이(TUI 결함 #5 · 10-14).
//
// 반복마다 그 턴의 finalizeTurn 이 손잡이를 stop() 한다. 다음 반복이 같은 손잡이를 다시 쓰면
// 표시가 없거나(멈춘 손잡이) 멈춘 «Thinking…» 프레임이 이력에 남는다. 그래서 «다음 반복이 실제로
// 시작될 때만» 새 손잡이를 단다 — 루프가 끝난 뒤에 달면 아무도 stop() 하지 않는 표시가 남는다.

import type { ThinkingHandle } from '../thinking-line.js';

/** 반복 `iteration`(0부터)의 손잡이. 0 은 입력 직후 단 표시를 그대로, 그 뒤는 새로 단다. */
export function goalLoopIterationThinking(
  iteration: number,
  current: ThinkingHandle,
  start: () => ThinkingHandle,
): ThinkingHandle {
  return iteration === 0 ? current : start();
}
