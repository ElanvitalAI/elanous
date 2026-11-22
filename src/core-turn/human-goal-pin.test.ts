import { describe, expect, test } from 'bun:test';
// SEAT-HUMAN-GOAL-PIN (OP 배정 #128939 · OP 필수 #129875/#129908 정정) —
//   판별은 구조화 출처(opener kind)로만 한다: from.kind 가 없으면 사람(absent = human),
//   system · agent 출처는 자동 줄. 텍스트 접두사·정규식·키워드 판별 금지
//   (MSG-SOURCE-HIERARCHY 대표 11-17 §1 — "from a structured field, never from its wording").
//   저장소는 부모(TUI) 소유(OP ④): 부모가 핀을 쓰고 상태줄이 읽는다. child 는 payload 로
//   받은 parentPinnedGoal 을 우선한다 — child 교체/재기동 뒤 복구.
//   이 파일이 수리 전 RED: 구현 전 모듈(텍스트 접두사 판별)에서 아래 계약이 실패한다.
import type { MessageSource } from '../session/index.js';
import {
  createInMemoryGoalPinStore,
  pinnedGoalOf,
  releasePinnedGoal,
  resolvePinnedObjective,
  sessionGoalPinStore,
} from './human-goal-pin.js';

const HUMAN_LINE = '크론 5개부터 등록하고 나서 대기 알림을 정리해라';
// 접두사 없는 알림 본문 — 실제 진입로(entry: withQueueNoticeContext)가 `[notice · source]` 머리를
// 모델 앞에만 붙인다. 판별은 이 문무를 보지 않는다(① RED 지점).
const NOTICE_BODY = 'OP 우편 3건 도착 · 캡슐 완료 2건';
const SYSTEM_QUEUE: MessageSource = { kind: 'system', origin: 'queue-notice' };
const SYSTEM_WAKEUP: MessageSource = { kind: 'system', origin: 'scheduled' };
const AGENT_MAIL: MessageSource = { kind: 'agent', seat: 'OP', msgId: '129875' };

describe('SEAT-HUMAN-GOAL-PIN — 구조화 출처 판별 · 알림 턴은 목표를 못 바꿈', () => {
  test('① from 없음(opener 미전달)은 사람이 아니다 — fail-closed(OP #130461): 핀 없음·목표 없음', () => {
    const store = createInMemoryGoalPinStore();
    const r = resolvePinnedObjective({ sessionId: 's1', turnText: HUMAN_LINE }, store);
    expect(r.noticeTurn).toBe(true);
    expect(r.pinned).toBe(false);
    expect(r.objective).toBeUndefined();
  });

  test('① 문구가 알림처럼 보여도 출처가 사람이면 핀 — 판별은 문구가 아니라 출처(수리 전 RED)', () => {
    const store = createInMemoryGoalPinStore();
    const r = resolvePinnedObjective({ sessionId: 's1', from: { kind: 'human' }, turnText: '[notice · seat-mail]\n\n사람이 친 줄' }, store);
    expect(r.noticeTurn).toBe(false);
    expect(r.pinned).toBe(true); // ← 텍스트 판별 구현은 이 줄을 알림으로 잘못 본다
    expect(r.objective).toBe('[notice · seat-mail]\n\n사람이 친 줄');
  });

  test('① 접두사 없는 system · agent 자동 줄은 사람 줄이 아니다 — 문무와 무관', () => {
    const store = createInMemoryGoalPinStore();
    for (const from of [SYSTEM_QUEUE, SYSTEM_WAKEUP, AGENT_MAIL]) {
      const r = resolvePinnedObjective({ sessionId: 'fresh', from, turnText: NOTICE_BODY }, store);
      expect(r.noticeTurn).toBe(true);
      expect(r.pinned).toBe(false); // 자동 줄은 새 핀을 못 만든다
      expect(r.objective).toBeUndefined();
    }
  });

  test('② 고정 중 자동 줄 — objective = 고정 목표 그대로(알림 줄이 목표를 못 바꿈)', () => {
    const store = createInMemoryGoalPinStore();
    resolvePinnedObjective({ sessionId: 's1', from: { kind: 'human' }, turnText: HUMAN_LINE }, store);
    for (const from of [SYSTEM_QUEUE, SYSTEM_WAKEUP, AGENT_MAIL]) {
      const r = resolvePinnedObjective({ sessionId: 's1', from, turnText: NOTICE_BODY }, store);
      expect(r.noticeTurn).toBe(true);
      expect(r.pinned).toBe(true);
      expect(r.objective).toBe(HUMAN_LINE);
    }
  });

  test('③ 목표 완료 → 해제(releasePinnedGoal) — 이후 자동 줄은 종전 파생(objective 없음)', () => {
    const store = createInMemoryGoalPinStore();
    resolvePinnedObjective({ sessionId: 's1', from: { kind: 'human' }, turnText: HUMAN_LINE }, store);
    releasePinnedGoal('s1', store);
    const r = resolvePinnedObjective({ sessionId: 's1', from: SYSTEM_QUEUE, turnText: NOTICE_BODY }, store);
    expect(r.pinned).toBe(false);
    expect(r.objective).toBeUndefined();
  });

  test('④ 부모 소유 핀 전달(parentPinnedGoal) — 교체된 child 의 빈 저장소보다 부모 핀이 이긴다', () => {
    const parent = createInMemoryGoalPinStore();
    resolvePinnedObjective({ sessionId: 's1', from: { kind: 'human' }, turnText: HUMAN_LINE }, parent);
    const freshChildStore = createInMemoryGoalPinStore(); // child 교체 직후 — 저장소 비었음
    const r = resolvePinnedObjective({ sessionId: 's1', from: SYSTEM_QUEUE, turnText: NOTICE_BODY, parentPinnedGoal: parent.pinned.get('s1') }, freshChildStore);
    expect(r.pinned).toBe(true);
    expect(r.objective).toBe(HUMAN_LINE);
  });

  test('④ 세션 분리 — 옆 세션 오염 없음 · 상태줄 판독(pinnedGoalOf)은 부모 저장소를 본다', () => {
    const store = createInMemoryGoalPinStore();
    resolvePinnedObjective({ sessionId: 's1', from: { kind: 'human' }, turnText: HUMAN_LINE }, store);
    expect(resolvePinnedObjective({ sessionId: 's2', from: SYSTEM_QUEUE, turnText: NOTICE_BODY }, store).pinned).toBe(false);
    expect(pinnedGoalOf('s1')).toBeUndefined(); // 세션 단위 싱글턴(별도 저장소) — 분리 확인
    const sessionSingleton = sessionGoalPinStore();
    resolvePinnedObjective({ sessionId: 's-line', from: { kind: 'human' }, turnText: HUMAN_LINE }, sessionSingleton);
    expect(pinnedGoalOf('s-line')).toBe(HUMAN_LINE);
    releasePinnedGoal('s-line', sessionSingleton);
    expect(pinnedGoalOf('s-line')).toBeUndefined();
  });
});