// ── 실패 지문 사전 (L4 자기 인지 · TUI-FAILURE-SIGNATURES) ──
//
// 결함 기록(`seat-state/OPC/tui-op-issues.md`)을 «데이터»로 옮긴 것이다 — 증상 → 원인 → 처방.
// 지문 ↔ 결함 번호 ↔ 칸 대응은 PR #27498 본문 표가 정본이다(여기 복제하지 않는다).
// TUI 턴이 오류로 끝날 때 디버그 원문(영어 덤프) 대신 «무슨 일 → 다음 행동» 한국어 한 줄을 보이고,
// 원문은 `/detail` 쪽으로 보낸다. 설계 정본 = `RFC-tui-self-awareness-and-continuity` L4.
//
// ⭐ 공용 모듈이다 — 화면 경로(plain-turn 오류) 말고도 가드 문구 현지화
//    (UX `TUI-GUARD-NOTICE`)·자기 건강 한 줄(L3 `opc-self-health`)이 이 사전을 가져다 쓴다.
//    ⛔ 지문 문면을 호출부에 복제하지 말고 여기 한 줄을 더한다.
// 📋 관측: 지문이 맞으면 `debug.log('tui.failure-signature', 'matched', { id, surface })` 하나.
//    `elanous logs --category tui.failure-signature` 로 지문별 빈도를 센다.

import { debug } from '../debug/log.js';

export interface FailureEventInput {
  category: string;
  event: string;
  data?: Record<string, unknown>;
}

export interface FailureSignature {
  /** 안정 id — 관측 이벤트·L3 집계의 키. ⛔ 바꾸면 집계가 끊긴다. */
  readonly id: string;
  /** 오류 문자열·응답 문면에서 이 지문을 알아보는 패턴(하나라도 맞으면). */
  readonly text?: readonly RegExp[];
  /** 로그 이벤트로 알아보는 패턴. */
  readonly event?: {
    readonly category: string;
    readonly event: string;
    readonly when?: (data: Record<string, unknown>) => boolean;
  };
  /** 무슨 일 — 한국어 한 줄. */
  readonly cause: string;
  /** 다음 행동 — 한국어 한 줄. */
  readonly next: string;
}

/** 이벤트 루프 정지를 «지문»으로 볼 문턱 — 0.25s 표본은 잦아 소음이고, 결함 #1(14s)·#14(최대 2.35s)는 이 위다. */
export const EVENT_LOOP_STALL_SIGNATURE_MS = 2_000;

// ⚠️ 순서가 뜻이다 — 앞의 것이 먼저 맞는다. 원인 지문(400)을 결과 지문(공급자 소진) 앞에 둔다:
//    소진 문면 안에 `Codex API 400` 이 시도 이력으로 들어 있으면 처방은 400 쪽이 맞다.
export const FAILURE_SIGNATURES: readonly FailureSignature[] = [
  {
    id: 'codex-400-bad-request',
    // 모델 API 오류 머리로만 — `storage API 400 Bad Request` 같은 무관한 400 은 옛 출력 그대로 둔다.
    text: [/\b(?:Codex|LLM) API 400\b/],
    cause: '모델 API 가 요청을 400 으로 거절(대화 기록 어긋남 의심)',
    next: '/session new 뒤 짧게 다시 묻기',
  },
  {
    id: 'provider-fallback-exhausted',
    // 머리(`[LLM PROVIDER …]`)만으로는 안 맞춘다 — 소진이 아닌 STOPPED·BLOCKED 는 옛 출력 그대로 둔다.
    text: [/\[LLM PROVIDER (?:BLOCKED|STOPPED)\] fallback candidates exhausted/],
    cause: '응답이 끊겼고 대체 공급자도 못 씀',
    next: '잠시 뒤 다시 보내기 · 되풀이되면 eln usage',
  },
  {
    id: 'tool-budget-reached',
    text: [/Tool budget reached/],
    cause: '이 턴의 도구 호출 상한 소진(짧은 질문은 상한이 작다)',
    next: '«자세히 조사해» 로 다시 묻기',
  },
  {
    id: 'broad-search-loop',
    text: [/RUNTIME BLOCKED\W+repeated broad search loop/],
    cause: '넓은 탐색이 연달아 이어져 탐색 가드가 막음',
    next: '파일 경로를 짚어 읽게 하기',
  },
  {
    id: 'synthesis-ignored',
    text: [/\[(?:SYNTHESIS|ACTION|EXECUTION) IGNORED\]/],
    cause: '도구만 부르는 루프를 가드가 끊음(근거 부족)',
    next: '파일 3~5개로 좁혀 다시 묻기',
  },
  {
    id: 'event-loop-stall',
    event: {
      category: 'tui.event-loop',
      event: 'stall',
      when: (data) => typeof data.lagMs === 'number' && data.lagMs >= EVENT_LOOP_STALL_SIGNATURE_MS,
    },
    cause: '화면 루프가 2초 넘게 멈춤(TUI 안 무거운 동기 작업)',
    next: 'eln logs --event stall 로 직전 작업 보기',
  },
  {
    id: 'stale-build',
    event: { category: 'tui.run-state', event: 'stale' },
    cause: '이 TUI 는 옛 판으로 도는 중(설치본이 그 뒤 갱신)',
    next: 'TUI 다시 띄우기',
  },
];

/** 오류 문자열에 맞는 첫 지문. 순수 — 관측을 남기지 않는다.
 *  ⚠️ «던져진 오류·로그 이벤트»용이다 — 모델이 쓴 응답·도구 결과(인용이 섞인다)에 대면 오탐한다(PR #27498 r1~r5). */
export function matchFailureText(text: string): FailureSignature | null {
  if (!text) return null;
  for (const sig of FAILURE_SIGNATURES) {
    if (sig.text?.some((re) => re.test(text))) return sig;
  }
  return null;
}

/** 로그 이벤트에 맞는 첫 지문. 순수. */
export function matchFailureEvent(input: FailureEventInput): FailureSignature | null {
  for (const sig of FAILURE_SIGNATURES) {
    const ev = sig.event;
    if (!ev || ev.category !== input.category || ev.event !== input.event) continue;
    if (ev.when && !ev.when(input.data ?? {})) continue;
    return sig;
  }
  return null;
}

/** «무슨 일 → 다음 행동» 한국어 한 줄. `rawHint` 는 원문을 볼 자리(예: `/detail open`).
 *  ⚠️ 한 화면 줄(한글은 두 칸)에 들어가게 짧게 — 140칸 TUI 에서 처방이 잘리면(…+N) 한 줄의 뜻이 없다. */
export function formatFailureNotice(sig: FailureSignature, opts: { rawHint?: string } = {}): string {
  const raw = opts.rawHint ? ` · 원문 ${opts.rawHint}` : '';
  return `⚠ ${sig.cause} → ${sig.next}${raw}`;
}

/** 지문이 맞았다는 관측 한 줄 — L3 자기 건강이 이 이벤트를 센다. 관측은 화면을 막지 않는다. */
export function recordFailureSignatureMatch(
  sig: FailureSignature,
  surface: string,
  log: (category: string, event: string, data: Record<string, unknown>) => void = (c, e, d) => debug.log(c, e, d),
): void {
  try {
    log('tui.failure-signature', 'matched', { id: sig.id, surface });
  } catch { /* fail-soft — 관측이 화면을 막지 않는다 */ }
}
