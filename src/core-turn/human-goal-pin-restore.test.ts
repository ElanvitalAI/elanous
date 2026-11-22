import { describe, expect, test } from 'bun:test';
import { createInMemoryGoalPinStore, resolvePinnedObjective, releasePinnedGoal } from './human-goal-pin.js';
import type { MessageSource } from '../session/index.js';

// GOAL-PIN-2 (OP #130409/#130443 · SEAT-HUMAN-GOAL-PIN 후속) — ③ 24열 상태줄 📌 소실 수리 ·
// ④ child 교체 뒤 고정 복구: 부모(TUI) payload 핀이 이 프로세스 저장소보다 우선한다(계약 · human-goal-pin.ts:66-70).
// 여기는 순수 계약 시험 — 실 TUI PTY 종단(⑤)은 src/tui/ 별도 파일.

describe('GOAL-PIN-2 — ④ 고정 목표 복구(부모 소유 우선) · ③ 상태줄 📌 잔존', () => {
  const human: MessageSource = { kind: 'human' };

  test('④ child 교체(빈 저장소) 뒤에도 부모 payload 핀이 목표를 지킨다', () => {
    // child 가 재기동돼 프로세스 저장소가 비었다 — 부모가 payload 로 건 핀이 살아 있으면 목표는 유지된다.
    const freshChildStore = createInMemoryGoalPinStore(); // 재기동 뒤: 비어 있음
    const r = resolvePinnedObjective(
      { sessionId: 's-restart', from: { kind: 'agent', seat: 'OP' }, turnText: '[notice] 캡슐 완료', parentPinnedGoal: '배포 가동까지 수습' },
      freshChildStore,
    );
    expect(r.pinned).toBe(true);
    expect(r.objective).toBe('배포 가동까지 수습');
    expect(r.noticeTurn).toBe(true);
  });

  test('④ 부모 핀이 해제(완료)된 뒤에는 child 도 새로 고정하지 않는다', () => {
    const store = createInMemoryGoalPinStore();
    resolvePinnedObjective({ sessionId: 's1', from: human, turnText: '목표 A' }, store);
    releasePinnedGoal('s1', store);
    // 부모가 완료해 핀이 없다(undefined) — 알림 줄은 목표를 만들지 않는다(fail-closed).
    const r = resolvePinnedObjective({ sessionId: 's1', from: { kind: 'agent', seat: 'OP' }, turnText: '[notice] x' }, store);
    expect(r.pinned).toBe(false);
    expect(r.objective).toBeUndefined();
  });

  test('④ 사람 줄이 부모 핀보다 새롭다 — 마지막 사람 지시가 핀을 갱신한다', () => {
    const store = createInMemoryGoalPinStore();
    const r = resolvePinnedObjective(
      { sessionId: 's2', from: human, turnText: '새 방향 B', parentPinnedGoal: '옛 방향 A' },
      store,
    );
    expect(r.pinned).toBe(true);
    expect(r.objective).toBe('새 방향 B');
    expect(store.pinned.get('s2')).toBe('새 방향 B');
  });
});
