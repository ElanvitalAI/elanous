import { describe, expect, test } from 'bun:test';
import { formatNextTuiStatusLine } from './status-line.js';

// CEO 결정(NO-GOAL-FOOTER): 고정 목표(SEAT-HUMAN-GOAL-PIN)는 내부 턴 상태로만 남고 상태줄에는 보이지 않는다.
describe('NO-GOAL-FOOTER — 핀이 있는 세션의 상태줄에는 📌 도 목표 원문도 없다', () => {
  test.each([24, 32, 80])('폭 %i — 📌 없음 · 목표 원문 없음', (width) => {
    // 핀이 걸린 세션이어도 상태줄 입력에는 목표가 전달되지 않는다(입력 필드 자체가 없다) — 추가 필드는 무시되어야 한다.
    const input = {
      turnState: '응답 중', model: 'glm-5', queued: 2, steering: 0, backgroundTasks: 1, width,
      pinnedGoal: '배포 가동까지 수습',
    };
    const line = formatNextTuiStatusLine(input);
    expect(line.includes('📌')).toBe(false);
    expect(line.includes('Goal')).toBe(false);
    expect(line.includes('배포 가동까지 수습')).toBe(false);
    expect(Bun.stringWidth(line)).toBeLessThanOrEqual(width);
  });
});
