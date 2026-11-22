// ── 세션별 턴 중 이벤트함 (SEAT-TURN-MIDTURN-MAIL · OP #106231/#106233 · 설계 OP #106281) ──
//
// src/session/pending-input.ts(정본)과 같은 꼴의 레지스트리. 턴이 도는 동안 도착한 자리
// 우편(seat-mail)·캡슐 완료(capsule-done) 사건을 세션별로 쌓아 두고, run-core-turn 의
// drainPendingUserInput 클로저가 도구 호출 경계마다 배수해 interjection 문면으로 모델
// 입력에 끼워 넣는다(중복 0 · 도착순 보존 · seen 은 끼워 넣은 시점 · started 는 그 턴).
//   · 같은 (kind,id) 가 아직 대기 중이면 enqueue 는 false — 중복 0.
//   · OP #106762 ⓐ — 세션 1회: 이미 배수된 (kind,id) 도 다시 안 들어간다(우편 재방출·capsule 리플레이 방지).
//   · drain 는 비우면서 들어온 순서 그대로 낸다.
//   · onDrained 는 pending-input.ts:29 계약 그대로 — 배수 시 원본 큐에서 같은 사건을
//     지우는 뒷정리를 호출자가 한다(실패해도 배수를 막지 않는다).

import { debug } from '../debug/log.js';

/** 한 건의 턴 중 이벤트. id 는 어댑터 소유 고유 id(msgId/capsuleId). */
export interface MidTurnEventItem {
  readonly id: string;
  readonly kind: string;
  readonly text: string;
  readonly occurredAt: number;
  /** Seat mail provenance (sender · intent) — the drain renders seat mail as untrusted data. */
  readonly from?: string;
  readonly intent?: string | null;
}

/** pending-input.ts:29 계약 — 배수된 문면 전체와 항목 전체를 받는다. */
export type MidTurnDrainedCallback = (texts: readonly string[], items: readonly MidTurnEventItem[]) => void;

type QueuedMidTurnEvent = MidTurnEventItem & { readonly onDrained?: MidTurnDrainedCallback };

const sessions = new Map<string, QueuedMidTurnEvent[]>();
/** OP #106762 ⓐ — 그 세션에서 이미 배수된 (kind,id). 같은 사건은 세션 동안 한 번만. */
const drainedOnce = new Map<string, Set<string>>();

const onceKey = (kind: string, id: string): string => `${kind}\u0000${id}`;

/**
 * 턴 중 이벤트함에 한 건 넣는다. 같은 (kind,id) 가 대기 중이거나 그 세션에서 이미 배수됐으면
 * false(중복 0 · 세션 1회 — OP #106762 ⓐ).
 * `onDrained` 는 그 건이 배수될 때 배수된 전체 문면·항목과 함께 불린다.
 */
export function enqueueMidTurnEvent(
  sessionId: string,
  event: { kind: string; id: string; text: string; from?: string; intent?: string | null },
  onDrained?: MidTurnDrainedCallback,
): boolean {
  const queue = sessions.get(sessionId) ?? [];
  if (queue.some((item) => item.kind === event.kind && item.id === event.id)) {
    debug.log('llm.interjection', 'mid-turn-duplicate', { sessionId, kind: event.kind, id: event.id });
    return false;
  }
  // OP #106762 ⓐ — 세션 1회: 이미 배수된 (kind,id) 는 다시 안 들어간다(재방출·리플레이 방지).
  if (drainedOnce.get(sessionId)?.has(onceKey(event.kind, event.id)) === true) {
    debug.log('llm.interjection', 'mid-turn-drained-once', { sessionId, kind: event.kind, id: event.id });
    return false;
  }
  const item: QueuedMidTurnEvent = {
    id: event.id,
    kind: event.kind,
    text: event.text,
    occurredAt: Date.now(),
    ...(event.from === undefined ? {} : { from: event.from }),
    ...(event.intent === undefined ? {} : { intent: event.intent }),
    ...(onDrained === undefined ? {} : { onDrained }),
  };
  queue.push(item);
  sessions.set(sessionId, queue);
  debug.log('llm.interjection', 'mid-turn-queued', {
    sessionId, kind: event.kind, id: event.id, chars: event.text.length, waiting: queue.length,
  });
  return true;
}

/** 비우면서 도착순으로 낸다. onDrained 는 배수 시 불리고, 그 실패가 배수를 막지 않는다. */
export function drainMidTurnEvents(sessionId: string): MidTurnEventItem[] {
  const queue = sessions.get(sessionId);
  if (queue === undefined || queue.length === 0) return [];
  sessions.set(sessionId, []);
  const seenOnce = drainedOnce.get(sessionId) ?? new Set<string>();
  drainedOnce.set(sessionId, seenOnce);
  for (const item of queue) seenOnce.add(onceKey(item.kind, item.id));
  const drained: MidTurnEventItem[] = queue;
  const texts = drained.map((item) => item.text);
  for (const item of queue) {
    try { item.onDrained?.(texts, drained); } catch { /* 뒷정리 실패가 배수를 막지 않는다(fail-open) */ }
  }
  debug.log('llm.interjection', 'mid-turn-drained', {
    sessionId, count: drained.length, kinds: [...new Set(drained.map((item) => item.kind))],
  });
  return drained;
}

/** 그 세션 이벤트함에 대기 중인 건수. */
export function midTurnEventCount(sessionId: string): number {
  return sessions.get(sessionId)?.length ?? 0;
}

/** 그 세션 이벤트함을 비운다(턴 경계 정리). */
export function clearMidTurnEvents(sessionId: string): void {
  sessions.delete(sessionId);
  drainedOnce.delete(sessionId); // OP #106762 ⓐ — 세션 1회 집합도 같이 비운다.
}
