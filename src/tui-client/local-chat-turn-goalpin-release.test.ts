// GOAL-PIN-RELEASE — 답이 나간 사람 턴 뒤 핀 해제 · 알림 턴은 핀 유지 · 활성 골 루프는 완료까지 유지.
import { describe, expect, test } from 'bun:test';
import { createInMemoryGoalPinStore, releasePinnedGoal, resolvePinnedObjective } from '../core-turn/human-goal-pin.js';
import { shouldReleasePinAfterAnsweredTurn, shouldReleasePinForGoalLoop } from './local-chat-turn-goalpin-wire.js';
import { formatNextTuiStatusLine } from '../tui/chat/status-line.js';

const status = () => formatNextTuiStatusLine({
  turnState: '대기', model: 'm', queued: 0, steering: 0, backgroundTasks: 0, width: 120,
});

describe('GOAL-PIN-RELEASE', () => {
  test('사람 줄 → 턴 중 핀 · 답 나간 턴 종료 뒤 해제 · 상태줄에 📌 없음', () => {
    const store = createInMemoryGoalPinStore();
    resolvePinnedObjective({ sessionId: 's1', from: { kind: 'human' }, turnText: '배포 확인해줘' }, store);
    expect(store.pinned.get('s1')).toBe('배포 확인해줘');
    expect(status()).not.toContain('📌'); // NO-GOAL-FOOTER: 핀이 살아 있어도 상태줄에 보이지 않는다
    expect(status()).not.toContain('배포 확인해줘');
    if (shouldReleasePinAfterAnsweredTurn({ from: { kind: 'human' }, answered: true })) releasePinnedGoal('s1', store);
    expect(store.pinned.get('s1')).toBeUndefined();
    expect(status()).not.toContain('📌');
  });
  test('알림 턴은 핀을 덮지도 풀지도 않는다', () => {
    const store = createInMemoryGoalPinStore();
    resolvePinnedObjective({ sessionId: 's2', from: { kind: 'human' }, turnText: '목표 A' }, store);
    const r = resolvePinnedObjective({ sessionId: 's2', from: { kind: 'system', origin: 'queue-notice' }, turnText: '우편 도착' }, store);
    expect(r.objective).toBe('목표 A');
    expect(shouldReleasePinAfterAnsweredTurn({ from: { kind: 'system', origin: 'queue-notice' }, answered: true })).toBe(false);
    expect(store.pinned.get('s2')).toBe('목표 A');
  });
  test('답이 없거나 활성 골 루프면 유지 · update_goal complete 에서만 해제', () => {
    expect(shouldReleasePinAfterAnsweredTurn({ from: { kind: 'human' }, answered: false })).toBe(false);
    expect(shouldReleasePinAfterAnsweredTurn({ from: { kind: 'human' }, answered: true, goalStopReason: 'waiting' })).toBe(false);
    expect(shouldReleasePinAfterAnsweredTurn({ from: { kind: 'human' }, answered: true, goalStopReason: 'soft_stop' })).toBe(false);
    expect(shouldReleasePinAfterAnsweredTurn({ from: undefined, answered: true })).toBe(false);
    expect(shouldReleasePinForGoalLoop({ stopReason: 'goal_complete', completionVia: 'update_goal' })).toBe(true);
  });
});
