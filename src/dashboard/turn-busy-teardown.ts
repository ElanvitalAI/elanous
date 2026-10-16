// ── 턴 busy 표지 마감 (TUI-STALE-BUSY-MARKER · 0.2.31 · tui-op-issues #36·#37·#45·#54·#55·#58) ──
//
// S: 턴이 시작되면 `streamingInFlight = true` ⊕ `reportTuiTurn('busy')` 가 켜지고, 마감 closure 가
//    끄기 전까지 외부 입력 대기열(`isTurnActive`)·`eln pty state` 는 «바쁨»으로 본다.
// C: 마감 closure 안의 한 단계가 던지면(10-14 «✘ 실패 line.startsWith») 끄는 줄에 못 닿아 70분+ busy 가 남았다.
//    #27721 이 settle 단계 하나를 try/finally 로 감쌌지만, 그 «앞» 단계(키 리스너 떼기 · ESC 게이트 정리)는
//    여전히 맨몸이었다 — 거기서 던지면 키 층은 유휴(리스너 떨어짐)·턴 층은 busy 인 이원 판정이 그대로 재현된다.
//    그리고 실패는 `dashboard.turn settle-failed` 한 곳에서만 보였다(#58 — 턴 본문 실패는 tui 범주 0).
// A: 마감 단계마다 이 함수로 격리해 «다음 단계 ⊕ idle 전이»가 반드시 돌게 하고,
//    던진 것은 한 범주 `tui.turn turn-threw {error, phase}` 로 남긴다.

import { debug, redactSecretText } from '../debug/log.js';

/** 4번째 인자로 `{ level: 'warn' }` 를 받는다 — 주입 기록기도 warn 수준을 그대로 넘겨야 한다(#58). */
export type TurnThrewLog = (
  category: string,
  event: string,
  payload: Record<string, unknown>,
  opts?: { level?: 'warn' },
) => void;

const ERROR_HEAD_CHARS = 200;

const warnLog: TurnThrewLog = (category, event, payload, opts) => debug.log(category, event, payload, opts);

/** 턴 경로에서 던진 것을 한 범주로 남긴다(warn — #58 «warn/error 0» 의 몫). 관측 실패가 턴 마감을 막지 않는다. */
export function logTurnThrew(phase: string, err: unknown, log: TurnThrewLog = warnLog): void {
  try {
    const message = err instanceof Error ? err.message : String(err);
    const stackHead = err instanceof Error
      ? err.stack?.split('\n').slice(1, 3).map((line) => line.trim()).join(' | ')
      : undefined;
    log('tui.turn', 'turn-threw', {
      error: redactSecretText(message).slice(0, ERROR_HEAD_CHARS),
      phase,
      ...(stackHead ? { stackHead: redactSecretText(stackHead) } : {}),
    }, { level: 'warn' });
  } catch { /* fail-soft — 관측이 마감을 막지 않는다 */ }
}

/** 턴 마감의 한 단계 — 던져도 삼키고 `turn-threw` 로 남긴다. 다음 단계·idle 전이는 계속 돈다. */
export function runTurnTeardownStep(phase: string, step: () => void, log?: TurnThrewLog): boolean {
  try {
    step();
    return true;
  } catch (err) {
    logTurnThrew(phase, err, log);
    return false;
  }
}
