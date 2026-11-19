// ── 턴 «안»으로 들어가는 발화의 문면 ────────────────────────────────────────
//
// 🚨 무엇을 푸는가 (대표 지시 ②)
//   대표: *"큐잉된게 설계된 타이밍에 들어가서 인터럽트? 비슷한게 걸리면서 «기존 작업을 트리아지» 해야 하구요"*
//
// ⭐ ref 정렬 — grok-build `xai-interjection-core/src/format.rs` 가 이 자리를 «문면»으로 풀었다:
//     INTERJECTION_NOTE         "The user sent a message while you were working:"
//     INTERRUPT_NOTE            "The user interrupted the previous turn:"
//     UNFINISHED_TASKS_REMINDER "Make sure to complete any unfinished tasks from previous turns."
//     frame_user_turn = "{note}\n<user_query>…</user_query>\n{UNFINISHED_TASKS_REMINDER}"
//   📌 즉 ***"기존 작업을 버리지 마라"를 모델에게 «말로» 준다.*** 별도 판정기를 만들지 않는다.
//
// ⛔ 왜 이것이 «필요»한가 — 리마인더가 없으면 모델이 새 발화를 「지시 교체」로 읽고
//   돌던 작업을 통째로 버린다. 그 실패가 조용하다: 사용자는 «왜 하던 걸 안 했지» 만 본다.

import { REPLACEMENT_CANDIDATE_NOTE_PREFIX } from './queue-supersede.js';

/** 도는 턴 «중»에 사용자가 보낸 발화임을 알리는 머리말. */
export const INTERJECTION_NOTE = '작업 중에 사용자가 메시지를 보냈습니다:';

/** 사용자가 «이전 턴을 중단»한 뒤의 첫 발화임을 알리는 머리말. */
export const INTERRUPT_NOTE = '사용자가 이전 턴을 중단했습니다:';

/** ⭐ 트리아지 한 줄 — 이것이 「기존 작업을 버리지 마라」다. */
export const UNFINISHED_TASKS_REMINDER = '이전 턴의 미완 작업이 있으면 마저 끝내십시오.';

/** 너무 긴 발화는 잘라 넣는다(문맥 예산 보호). 잘렸다는 사실을 «숨기지 않는다». */
export const LARGE_PROMPT_THRESHOLD = 8_000;

export type InterjectionKind = 'mid-turn' | 'after-interrupt';

/** 사용자 발화를 봉투에 싼다. 순수. */
export function wrapUserQuery(text: string): string {
  return `<user_query>\n${text}\n</user_query>`;
}

/** 예산 초과분을 자르되 «잘렸음»을 문면으로 남긴다. 순수. */
export function capInterjectionText(text: string, limit = LARGE_PROMPT_THRESHOLD): string {
  if (text.length <= limit) return text;
  const kept = text.slice(0, limit);
  return `${kept}\n… [${text.length - limit}자 생략됨]`;
}

/**
 * ★ 턴 «안»에 끼워 넣을 사용자 발화 한 덩어리를 만든다. 순수.
 *
 * ⭐ 여러 건이 대기 중이면 «순서를 보존해» 한 덩어리로 싼다 —
 *   ⛔ 건마다 따로 넣으면 모델이 매번 「작업을 계속하라」를 다시 읽어야 하고,
 *     그 반복이 문맥을 먹으면서 정작 원래 작업 설명을 밀어낸다.
 */
export function buildInterjectionMessage(
  texts: readonly string[],
  kind: InterjectionKind = 'mid-turn',
): string | null {
  const items = texts.map((t) => t.trim()).filter((t) => t.length > 0);
  if (items.length === 0) return null;
  const note = kind === 'mid-turn' ? INTERJECTION_NOTE : INTERRUPT_NOTE;
  const body = items.map((t) => wrapUserQuery(capInterjectionText(t))).join('\n');
  return `${note}\n${body}\n${UNFINISHED_TASKS_REMINDER}`;
}

/**
 * ★ 이력에 남기는 «중단» 표식 — `A3`ⓑ.
 *
 * ⭐ ref 정렬(claude-code `utils/messages.ts`): `INTERRUPT_MESSAGE = '[Request interrupted by user]'`.
 *   그 창의 이력 순서는 ***`[user, partial-assistant, [Request interrupted by user]]`***이고,
 *   ⇒ 🔑 ***반복 인터럽트는 이 삼중항이 «쌓이는» 것***이다. 그래서 다음 발화 때 모델이
 *     「어디까지 했고 몇 번 멈췄는지」를 «스스로» 종합한다 — 종합기를 따로 만들지 않는다(`A4`).
 *
 * 📏 elanous 실측(2026-08-19): ***부분 출력은 이미 보존된다***(`session/chat.ts` 가 중단 여부와
 *   무관하게 assistant 메시지를 저장). ⇒ 빠져 있던 것은 이 «표식» 하나뿐이었다.
 */
export const TURN_INTERRUPTED_MARKER = '[사용자가 이 턴을 중단했습니다]';
/** Automatic idle watchdog cancellation is not a user interruption. */
export const TURN_STALLED_MARKER = '[응답 정체로 이 턴이 자동 중단됐습니다]';

/** 중단 표식 메시지 한 줄. 도구가 돌던 중이면 그 사실도 같이 남긴다. 순수. */
export function buildTurnInterruptedMarker(opts?: { toolInFlight?: boolean; reason?: 'stall' }): string {
  const marker = opts?.reason === 'stall' ? TURN_STALLED_MARKER : TURN_INTERRUPTED_MARKER;
  return opts?.toolInFlight
    ? `${marker} — 진행 중이던 도구 호출도 함께 끊겼습니다.`
    : marker;
}

/**
 * A200 — 취소 뒤 «자동 제출»되는 대기 입력 앞에 붙이는 맥락 한 줄(codex `TurnAborted` 꼴).
 * ⭐ Next TUI 는 Esc 에 자식 REPL 을 닫으므로 `TURN_INTERRUPTED_MARKER` 가 이력에 남지 않는다 —
 *   그래서 다음 턴의 모델 입력에 이 한 줄을 싣는다(화면 말풍선은 사람 문장 그대로).
 */
export const INTERRUPTED_ON_PURPOSE_NOTE = '[사용자가 직전 턴을 의도적으로 중단했습니다. 중단된 도구·명령은 일부만 실행됐을 수 있으니 다시 하기 전에 현재 상태를 확인하십시오.]';

/** 취소 뒤 자동 제출되는 발화에 맥락 한 줄을 앞세운다. 순수. */
export function withInterruptedOnPurposeContext(text: string): string {
  return `${INTERRUPTED_ON_PURPOSE_NOTE}\n\n${text}`;
}

/** 화면·앵커용 — 맥락 한 줄을 떼어 사람 문장만 돌려준다. 순수. */
export function stripInterruptedOnPurposeContext(text: string): string {
  const prefix = `${INTERRUPTED_ON_PURPOSE_NOTE}\n\n`;
  return text.startsWith(prefix) ? text.slice(prefix.length) : text;
}

/**
 * ELN-QUEUE-SUPERSEDE — 대체 후보 맥락 한 줄을 새 발화 앞에 붙인다(줄 자체는 `queue-supersede.ts` 가 만든다).
 * 화면 말풍선은 사람 문장 그대로 — {@link stripQueueModelContext} 가 뗀다. 순수.
 */
export function withReplacementCandidateContext(text: string, contextLine: string): string {
  return `${contextLine}\n\n${text}`;
}

/**
 * 화면·앵커용 — 큐가 모델에게만 붙인 맥락 줄(중단 한 줄 · 대체 후보 한 줄)을 떼어 사람 문장만 돌려준다. 순수.
 * 붙이는 순서는 중단 줄 → 대체 후보 줄 → 사람 문장이다.
 */
export function stripQueueModelContext(text: string): string {
  let rest = stripInterruptedOnPurposeContext(text);
  if (rest.startsWith(REPLACEMENT_CANDIDATE_NOTE_PREFIX)) {
    const end = rest.indexOf('\n\n');
    if (end >= 0 && !rest.slice(0, end).includes('\n')) rest = rest.slice(end + 2);
  }
  if (rest.startsWith(QUEUE_NOTICE_NOTE_PREFIX)) {
    const end = rest.indexOf('\n\n');
    if (end >= 0 && !rest.slice(0, end).includes('\n')) rest = rest.slice(end + 2);
  }
  return rest;
}

/**
 * mf1(#38102 r4) — 큐 notice(sidetab · harness-child · seat-mail)가 모델에게만 앞세우는 출처 한 줄.
 * 화면 말풍선은 notice 본문 그대로 — {@link stripQueueModelContext} 가 뗀다. 순수.
 */
export const QUEUE_NOTICE_NOTE_PREFIX = '[notice · ';

export function withQueueNoticeContext(text: string, source: string): string {
  return `${QUEUE_NOTICE_NOTE_PREFIX}${source}]\n\n${text}`;
}

/** 화면·앵커용 — notice 출처 줄을 떼고 본문만 돌려준다. 순수. */
export function stripQueueNoticeContext(text: string): string {
  if (!text.startsWith(QUEUE_NOTICE_NOTE_PREFIX)) return text;
  const end = text.indexOf('\n\n');
  if (end < 0 || text.slice(0, end).includes('\n')) return text;
  return text.slice(end + 2);
}
