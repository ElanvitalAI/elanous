// ── 세션별 «턴 중 대기 발화» 레지스트리 ────────────────────────────────────
//
// 🚨 무엇을 푸는가 (대표 지시 ②)
//   대표: *"큐잉된게 «설계된 타이밍»에 들어가서 인터럽트 비슷한게 걸리면서 기존 작업을 트리아지"*
//
// ⛔ 왜 클로저가 아니라 «레지스트리»인가 — 라이브 실측(2026-08-19):
//   TUI 의 큐는 대시보드에, 에이전트 루프는 ACP «서버» 쪽 `runCoreTurn` 에 있다.
//   ⭐ 둘은 ***같은 프로세스***다(로그 스토어가 같다: `llm.router` 와 `chat-main.plain-turn`
//     둘 다 `test:elanous-drive-Og2Z6M`) — 그러나 «RPC 경계»가 사이에 있어 클로저를 못 넘긴다.
//   ⇒ 그래서 «세션 id 로 만나는» 자리를 하나 둔다.
//
// ⚠️ 한계(정직하게): 이것은 ***같은 프로세스*** 전제다. 데몬이 다른 프로세스인 구성에서는
//   ACP 에 진짜 `steer` 메서드가 필요하다(`clientSessionSteer` 가 이미 있으나 elanous 자체
//   backend 는 `steer()` 를 «구현하지 않는다» — 호출자도 0이다). 그 확장은 별건이다.

import { randomUUID } from 'node:crypto';
import { debug } from '../debug/log.js';

/** 레지스트리 항목 — ⭐ id 는 «원본 큐»가 배수·되꺼내기·턴 종료 승격을 짝지을 때 쓴다(10-14 중복 수리). */
export interface PendingUserInputItem {
  id: string;
  text: string;
}

export type PendingUserInputDrained = (drained: readonly string[], items: readonly PendingUserInputItem[]) => void;

interface PendingBucket {
  items: PendingUserInputItem[];
  /** 배수될 때 «원본 큐»도 비우라고 알린다 — 안 그러면 같은 발화가 턴 끝에 «또» 나간다. */
  onDrained?: PendingUserInputDrained;
}

const buckets = new Map<string, PendingBucket>();
let nextPendingId = 0;
// 프로세스마다 다른 머리 — 재기동 뒤 `pending-1` 이 다시 나와 로그에서 id 가 겹치는 것을 막는다(실물 10-15).
const pendingIdPrefix = randomUUID().slice(0, 8);

/**
 * 이 세션의 도는 턴에 끼워 넣을 발화를 쌓는다. 쌓인 항목의 id 를 낸다(안 쌓았으면 null).
 * ⭐ 호출측은 이 id 로 «자기가 넣은 항목»만 다시 떨어낸다 — 문자열·위치로 짝지으면 같은 버킷에 든
 *   남의 항목(goal-loop 제어 메모 등)까지 지운다.
 */
export function enqueuePendingUserInput(
  sessionId: string,
  text: string,
  onDrained?: PendingUserInputDrained,
): string | null {
  const trimmed = text.trim();
  if (!sessionId || trimmed.length === 0) return null;
  const bucket = buckets.get(sessionId) ?? { items: [] };
  nextPendingId += 1;
  const id = `pending-${pendingIdPrefix}-${nextPendingId}`;
  bucket.items.push({ id, text: trimmed });
  if (onDrained) bucket.onDrained = onDrained;
  buckets.set(sessionId, bucket);
  debug.log('llm.interjection', 'enqueued', { sessionId, id, queued: bucket.items.length });
  return id;
}

/**
 * ★ 쌓인 발화를 «비우면서» 낸다. 루프 경계에서 불린다.
 * ⛔ 비우는 것이 계약이다 — 안 비우면 매 바퀴 같은 발화가 다시 들어간다.
 */
export function drainPendingUserInput(sessionId: string): string[] {
  const bucket = buckets.get(sessionId);
  if (!bucket || bucket.items.length === 0) return [];
  const items = bucket.items;
  bucket.items = [];
  const drained = items.map(item => item.text);
  // ⭐ 주입 횟수의 정본 관측 — 이 id 들이 지금 루프 경계로 넘어간다(RFC v2 P1 ⓑ · 내용은 남기지 않는다).
  debug.log('llm.interjection', 'drained', { sessionId, ids: items.map(item => item.id) });
  try { bucket.onDrained?.(drained, items); } catch { /* 통지 실패가 배수를 막지 않는다 */ }
  return drained;
}

/**
 * id 로 항목을 떨어낸다 — 원본 큐가 그 발화를 «다른 길»(턴 종료 승격·되꺼내기·중단 복원)로
 * 가져갔을 때 부른다. 세션을 몰라도 된다(id 는 프로세스 안에서 유일하다).
 * 소비자 배수가 아니므로 onDrained 를 부르지 않는다. 지운 수를 낸다.
 */
export type PendingUserInputRemovalReason = 'submitted-as-prompt' | 'restored-after-interrupt' | 'recalled' | 'unspecified';

export function removePendingUserInput(
  ids: readonly string[],
  reason: PendingUserInputRemovalReason = 'unspecified',
): number {
  if (ids.length === 0) return 0;
  const wanted = new Set(ids);
  const removedIds: string[] = [];
  for (const bucket of buckets.values()) {
    bucket.items = bucket.items.filter(item => {
      if (!wanted.has(item.id)) return true;
      removedIds.push(item.id);
      return false;
    });
  }
  // ⭐ «실제로» 뺀 id 만 남긴다 — 이미 배수·삭제된 id 를 다시 빼려 한 것은 requested 로만 보인다.
  debug.log('llm.interjection', 'removed', { ids: removedIds, requested: ids.length, removed: removedIds.length, reason });
  return removedIds.length;
}

/** 지금 이 세션에 대기 중인 수(관측·표시용). 비우지 «않는다». */
export function pendingUserInputCount(sessionId: string): number {
  return buckets.get(sessionId)?.items.length ?? 0;
}

/**
 * 턴/세션이 끝나면 버린다 — 남겨 두면 다음 턴에 «유령 발화»가 들어간다.
 * promotedInput 이 있으면 정식 프롬프트로 승격된 그 발화 하나만 떨어낸다.
 * 부분 삭제는 소비자 배수가 아니므로 bucket 과 onDrained 콜백을 보존하고 콜백을 호출하지 않는다.
 * ⭐ 자기가 넣은 항목을 id 로 떨어내는 일은 `removePendingUserInput(ids)` 가 따로 한다(같은 글이 둘이면 문자열로는 못 가른다).
 */
export function clearPendingUserInput(sessionId: string, promotedInput?: string): void {
  if (promotedInput === undefined) {
    const dropped = buckets.get(sessionId)?.items.map(item => item.id) ?? [];
    buckets.delete(sessionId);
    if (dropped.length > 0) debug.log('llm.interjection', 'discarded', { sessionId, ids: dropped });
    return;
  }

  const bucket = buckets.get(sessionId);
  if (!bucket) return;

  const matchIndex = bucket.items.findIndex(item => item.text === promotedInput);
  if (matchIndex === -1) return;
  bucket.items.splice(matchIndex, 1);
}
