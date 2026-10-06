import { describe, expect, test } from 'bun:test';
import { judgeNextMove } from './judge.js';

describe('TASK-AGENT 판단부 — 종료 어휘 → 다음 한 수 (RFC §A2)', () => {
  test('converged ⊕ 병합 → green 제안', () => {
    const j = judgeNextMove({ stopReason: 'converged', prState: 'MERGED', pr: 123 });
    expect(j.move).toBe('propose-green');
    expect(j.executorKind).toBe('green');
  });

  test('converged 인데 병합 근거 없음 → 대기 (green 아님)', () => {
    expect(judgeNextMove({ stopReason: 'converged', prState: 'OPEN', pr: 1 }).move).toBe('wait');
    expect(judgeNextMove({ stopReason: 'converged', prState: 'MERGED' }).move).toBe('wait');
  });

  test('harvestable/needs-human: 리뷰 미관측 → review · pass → land · fail → must-fix 로 좁혀 재발사', () => {
    for (const stopReason of ['harvestable-awaiting-human', 'needs-human'] as const) {
      expect(judgeNextMove({ stopReason }).move).toBe('review');
      const land = judgeNextMove({ stopReason, review: 'pass' });
      expect(land.move).toBe('propose-land');
      expect(land.executorKind).toBe('land');
      const fail = judgeNextMove({ stopReason, review: 'fail', mustFix: ['A 원문 확보', '테스트 추가'] });
      expect(fail.move).toBe('narrow-relaunch');
      expect(fail.reason).toContain('A 원문 확보 · 테스트 추가');
    }
  });

  test('no-progress · decomposable-no-progress → 좁혀 재발사', () => {
    expect(judgeNextMove({ stopReason: 'no-progress' }).move).toBe('narrow-relaunch');
    expect(judgeNextMove({ stopReason: 'decomposable-no-progress' }).move).toBe('narrow-relaunch');
  });

  test('provider-exhausted · step-timeout → 대기 후 재시도', () => {
    expect(judgeNextMove({ stopReason: 'provider-exhausted' }).move).toBe('wait-retry');
    expect(judgeNextMove({ stopReason: 'step-timeout' }).move).toBe('wait-retry');
  });

  test('handed-off-to-salvage → 수확 diff 로 이어 발사', () => {
    expect(judgeNextMove({ stopReason: 'handed-off-to-salvage' }).move).toBe('salvage-relaunch');
  });

  test('종료 관측 없음 → 대기 · 표에 없는 어휘 → 결정 카드', () => {
    expect(judgeNextMove({}).move).toBe('wait');
    const unknown = judgeNextMove({ stopReason: 'max-rounds' });
    expect(unknown.move).toBe('decision-card');
    expect(unknown.executorKind).toBe('decision');
  });

  test('같은 수 2번 실패 → 다른 수 · 대안도 실패 → 결정 카드', () => {
    expect(judgeNextMove({ stopReason: 'no-progress', failures: { 'narrow-relaunch': 1 } }).move).toBe('narrow-relaunch');
    const alt = judgeNextMove({ stopReason: 'no-progress', failures: { 'narrow-relaunch': 2 } });
    expect(alt.move).toBe('alternative');
    expect(alt.reason).toContain('narrow-relaunch');
    const card = judgeNextMove({ stopReason: 'no-progress', failures: { 'narrow-relaunch': 2, alternative: 1 } });
    expect(card.move).toBe('decision-card');
    expect(card.stage).toBe('escalated');
  });

  test('대기는 실패 누적으로 대안이 되지 않는다', () => {
    expect(judgeNextMove({ failures: { wait: 5 } }).move).toBe('wait');
  });
});
