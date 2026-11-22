import { describe, expect, test } from 'bun:test';
import { formatNextTuiStatusLine } from './status-line.js';
import type { NextTuiStatusLineInput } from './status-line.js';

// GOAL-PIN-2 ③ (OP #130409/#130443 · SEAT-HUMAN-GOAL-PIN 후속) — 좁은 상태줄(24·32열)에서도
// 고정 목표 📌 표지가 소실되지 않는다. 1차 #39578의 주석 계약(«좁으면 📌»)이 폴백 사다리에서
// 지켜지지 않았다: 📌 후보는 넓은 줄 2개뿐, 그 아래 폴백은 📌 없이 흘러 24/32열에서 📌가 통째로 사라졌다.

describe('GOAL-PIN-2 ③ — 고정 목표 📌 절은 좁은 상태줄에서도 살아남는다', () => {
  const base: NextTuiStatusLineInput = {
    turnState: '응답 중',
    model: 'glm-5',
    queued: 2,
    steering: 0,
    backgroundTasks: 1,
    width: 24,
    pinnedGoal: '배포 가동까지 수습',
  };

  test('24열 — 📌 표지가 출력에 살아 있다(목표 원문은 잘려도 표지는 소실되지 않는다)', () => {
    const line = formatNextTuiStatusLine(base);
    expect(line.includes('📌')).toBe(true);
    expect(Bun.stringWidth(line)).toBeLessThanOrEqual(24); // 출처: #39634 — 좁은 상태줄 24열 폭 규격(width 시나리오 원문 · OP #128939 ③)
  });

  test('32열 — 📌 표지가 출력에 살아 있다', () => {
    const line = formatNextTuiStatusLine({ ...base, width: 32 });
    expect(line.includes('📌')).toBe(true);
    expect(Bun.stringWidth(line)).toBeLessThanOrEqual(32); // 출처: #39634 — 좁은 상태줄 32열 폭 규격(width 시나리오 원문 · OP #128939 ③)
  });

  test('넓은 폭(80) — 종전 계약 그대로 📌 절과 목표 원문이 보인다', () => {
    const line = formatNextTuiStatusLine({ ...base, width: 80 });
    expect(line.includes('📌')).toBe(true);
    expect(line.includes('배포 가동까지 수습')).toBe(true);
  });

  test('핀이 없으면 종전 출력 그대로(회귀 0) — 24열 📌 미포함', () => {
    const line = formatNextTuiStatusLine({ ...base, pinnedGoal: undefined });
    expect(line.includes('📌')).toBe(false);
  });
});
