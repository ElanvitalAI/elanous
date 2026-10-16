// TUI-SEAT-TURN-CAP(0.2.31 · OP #9266) — 자리 TUI 의 goal loop 에서만 쓰는 «한 core 턴» 상한 ⊕ «할 일 0» 판정.
//
// 배경(10-16 실측): H1(#28487)로 자리 TUI 운영 지시가 goal loop 를 타면서 «1턴 정지» 는 풀렸지만, 반대로 한 core 턴이
// 도구 121개·18분+ 이어졌다(운영 `llm.maxTurns.codex = null` = 무제한). 전역 config 는 하니스 자식까지 걸리므로
// 자리 TUI 한정 손잡이를 둔다. 또 일이 떨어진 뒤 빈 MsgList 를 연달아 부르며 턴 안에서 폴링했다(«할 일 0 = 완료» 신호 부재).
//
// ⛔ 이 모듈은 import 0 — user-config 가 파서를 가져다 쓴다(순환 없음).

export interface SeatTurnCapConfig {
  /** core 턴 1회당 실행할 도구 수 상한. update_goal 진행 선언(in_progress·blocked)도 한 번으로 세고, 완료 신호(complete)만 뺀다.
   *  넘는 호출은 실행하지 않는다. */
  maxTools: number;
  /** core 턴 1회당 벽시계 상한(ms). 넘으면 다음 도구 호출부터 실행하지 않는다. */
  maxWallMs: number;
  /** 같은 core 턴에서 «새 항목 0» 우편 조회(MsgList)가 연속 이만큼이면 «할 일 0» 으로 완료. */
  idleEmptyMsgListLimit: number;
}

export const SEAT_TURN_CAP_DEFAULTS: SeatTurnCapConfig = {
  maxTools: 60,
  maxWallMs: 20 * 60_000,
  idleEmptyMsgListLimit: 2,
};

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** `chat.seatTurnCap` 원문을 읽는다. 객체가 아니거나 유효한 칸이 하나도 없으면 undefined(= 기본값). */
export function parseSeatTurnCapConfig(raw: unknown): Partial<SeatTurnCapConfig> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const out: Partial<SeatTurnCapConfig> = {};
  const maxTools = positiveInt(r.maxTools);
  const maxWallMs = positiveInt(r.maxWallMs);
  const idle = positiveInt(r.idleEmptyMsgListLimit);
  if (maxTools !== undefined) out.maxTools = maxTools;
  if (maxWallMs !== undefined) out.maxWallMs = maxWallMs;
  if (idle !== undefined) out.idleEmptyMsgListLimit = idle;
  return Object.keys(out).length > 0 ? out : undefined;
}

export function resolveSeatTurnCap(override: Partial<SeatTurnCapConfig> | undefined): SeatTurnCapConfig {
  return { ...SEAT_TURN_CAP_DEFAULTS, ...(override ?? {}) };
}

/** 우편 조회 도구 이름(카탈로그 aliases). */
export const MAIL_LIST_TOOL_NAMES: ReadonlySet<string> = new Set(['MsgList', 'msg_list']);

/** 결과가 «새 항목 0» 인 우편 조회인가. 구조체 `count === 0` 만 본다(문자열·messages 길이 추정 없음 — 리뷰 r1). */
export function isEmptyMailListResult(name: string, result: unknown): boolean {
  if (!MAIL_LIST_TOOL_NAMES.has(name)) return false;
  if (!result || typeof result !== 'object') return false;
  return (result as { count?: unknown }).count === 0;
}

/** 셸 도구 이름(카탈로그 aliases — RunShell·Bash 계열). */
export const SHELL_TOOL_NAMES: ReadonlySet<string> = new Set(['RunShell', 'run_shell', 'exec_argv', 'Bash', 'shell']);

/** 대기용 셸 호출(`sleep N`)인가 — 폴링 사이의 기다림은 «할 일 0» 연속을 끊지 않는다. 셸 도구에만 예외(리뷰 r2). */
export function isIdleWaitCall(name: string, args: unknown): boolean {
  if (!SHELL_TOOL_NAMES.has(name)) return false;
  if (!args || typeof args !== 'object') return false;
  const command = (args as { command?: unknown }).command;
  return typeof command === 'string' && /^\s*sleep\s+\d+(?:\.\d+)?[smh]?\s*;?\s*$/.test(command);
}

export const SEAT_TURN_CAP_TOOL_NOTICE = (reason: 'tools' | 'wall', cap: SeatTurnCapConfig): string =>
  `SEAT TURN CAP — this core turn reached its ${reason === 'tools' ? `tool limit (${cap.maxTools} tools)` : `wall-clock limit (${Math.round(cap.maxWallMs / 60_000)} min)`}; this call was NOT run. `
  + 'Do not call more tools in this turn. Write a one-line progress summary now (what is done · what remains) and end the turn; '
  + 'the goal loop starts the next iteration and you continue the remaining work there.';

export const SEAT_IDLE_NO_WORK_NOTICE = (limit: number): string =>
  `NO NEW WORK — ${limit} consecutive mailbox checks returned 0 new messages. Do not poll again in this turn. `
  + 'Write a one-line status and end the turn; this goal is complete (waiting for new mail is handled outside the turn).';

export const SEAT_TURN_CAP_CONTINUE_PROMPT =
  '앞 core 턴이 자리 턴 상한(도구 수 또는 벽시계)에 닿아 마감됐다. 위의 진행 요약을 이어받아 남은 일을 계속하라. '
  + '다 끝났으면 update_goal(status:"complete", evidence) 로 마감하라.';
