// TUI-SEAT-TURN-CAP — 자리 TUI 의 goal loop 호출(자리 턴) 전체에서 쓰는 도구·벽시계 상한 ⊕ «할 일 0» 판정.
//
// 배경(10-16 실측): H1(#28487)로 자리 TUI 운영 지시가 goal loop 를 타면서 «1턴 정지» 는 풀렸지만, 자리 턴이
// 도구 121개·18분+ 이어졌다(운영 `llm.maxTurns.codex = null` = 무제한). 전역 config 는 하니스 자식까지 걸리므로
// 자리 TUI 한정 손잡이를 둔다. 또 일이 떨어진 뒤 빈 MsgList 를 연달아 부르며 턴 안에서 폴링했다(«할 일 0 = 완료» 신호 부재).
//
// ⛔ 이 모듈은 import 0 — user-config 가 파서를 가져다 쓴다(순환 없음).

export interface SeatTurnCapConfig {
  /** 자리 턴 1회당 실행할 도구 수 상한. update_goal 진행 선언(in_progress·blocked)도 한 번으로 세고, 완료 신호(complete)만 뺀다.
   *  넘는 호출은 실행하지 않는다. */
  maxTools: number;
/** 자리 턴 1회당 벽시계 상한(ms). 넘으면 현재 core 턴을 중단하고 자리 턴을 마감한다. */
  maxWallMs: number;
  /** 같은 core 반복에서 «새 항목 0» 우편 조회(MsgList)가 연속 이만큼이면 «할 일 0» 으로 완료. */
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

// APP-BUILD-TOOL-WALL-CAP(11-17 run d2eab21a) — 자리 턴 벽시계 상한이 회원 게시 승인 창을 쥔 app_build 를 끊었다.
//   승인을 쥘 수 있는 도구가 실행 중이면 상한은 «미룬다»: 새 도구는 막되 진행 중 호출은 끊지 않고,
//   그 도구가 돌아오거나 승인 창 마감이 지나면 턴을 닫는다.

/** 회원 게시 승인 창을 쥘 수 있는 도구. 출처: src/plugins/core/app-build-autofill.ts APP_BUILD_TOOL_NAME(이 모듈은 import 0 이라 문자열로 둔다). */
export const OWNER_APPROVAL_TOOL_NAMES: ReadonlySet<string> = new Set(['app_build']);

/** 게시 승인 노드에서 여는 신뢰 승인 창 길이. 출처: src/cli/child-plugin-runtime.ts app-build-owner-publish-approval invoke(종전 리터럴 15 * 60_000). */
export const APP_BUILD_OWNER_APPROVAL_WINDOW_MS = 15 * 60_000;

/** 창 마감 뒤 승인 노드가 실패를 기록하고 도구가 돌아올 여유. 출처: 승인 transport 1회 상한 5s(capability-providers/app-build-publish-approval.ts) 의 12배. */
export const SEAT_CAP_APPROVAL_DEFER_GRACE_MS = 60_000;

/** 상한이 승인 도구 때문에 미룰 수 있는 최장 시간 — 상한 시각부터 승인 창 한 벌 ⊕ 여유. 이 뒤엔 미룸 없이 턴을 끊는다. */
export const SEAT_CAP_APPROVAL_DEFER_MAX_MS = APP_BUILD_OWNER_APPROVAL_WINDOW_MS + SEAT_CAP_APPROVAL_DEFER_GRACE_MS;

/** 미룬 상한에서 승인 도구가 돌아온 뒤 모델이 결과를 읽고 한 줄 요약으로 마감할 여유. 출처: 상한 안내(SEAT_TURN_CAP_TOOL_NOTICE) 뒤 요약 1회 응답 — 기본 벽시계 상한(20분)의 1/10. */
export const SEAT_CAP_DEFERRED_WRAPUP_MS = 2 * 60_000;

/** 자리 턴 상한이 core 턴을 끊을 때 쓰는 abort reason. 하위 승인 노드는 이 reason 으로 «상한에 끊김» 을 사람 거절과 가른다. */
export const SEAT_TURN_CAP_ABORT_CODE = 'SEAT_TURN_CAP_ABORT';
export class SeatTurnCapAbort extends Error {
  readonly code = SEAT_TURN_CAP_ABORT_CODE;
  constructor(readonly capReason: 'tools' | 'wall' | 'idle' | 'backstop') {
    super(`seat turn cap reached (${capReason})`);
    this.name = 'SeatTurnCapAbort';
  }
}

export function isSeatTurnCapAbort(reason: unknown): boolean {
  return !!reason && typeof reason === 'object' && (reason as { code?: unknown }).code === SEAT_TURN_CAP_ABORT_CODE;
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
  `SEAT TURN CAP — this seat turn reached its ${reason === 'tools' ? `tool limit (${cap.maxTools} tools)` : `wall-clock limit (${Math.round(cap.maxWallMs / 60_000)} min)`}; this call was NOT run. `
  + 'Do not call more tools. Write a one-line progress summary now (what is done · what remains) and end the seat turn. The person or next seat turn will resume later.';

export const SEAT_IDLE_NO_WORK_NOTICE = (limit: number): string =>
  `NO NEW WORK — ${limit} consecutive mailbox checks returned 0 new messages. Do not poll again in this turn. `
  + 'Write a one-line status and end the turn; this goal is complete (waiting for new mail is handled outside the turn).';

/** Kept as an import-compatible label for callers that distinguish the legacy cap continuation. */
export const SEAT_TURN_CAP_CONTINUE_PROMPT =
  '앞 core 턴이 자리 턴 상한(도구 수 또는 벽시계)에 닿아 마감됐다. 위의 진행 요약을 이어받아 남은 일을 계속하라. '
  + '다 끝났으면 update_goal(status:"complete", evidence) 로 마감하라.';
