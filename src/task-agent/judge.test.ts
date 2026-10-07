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

  test('새 관측이 이긴다 — 지난 대안 실패가 남아도 병합 → green 제안 · 종료 미관측 → 대기', () => {
    const stale = { alternative: 1, 'narrow-relaunch': 2 } as const;
    const green = judgeNextMove({ stopReason: 'converged', prState: 'MERGED', pr: 77, failures: stale });
    expect(green.move).toBe('propose-green');
    expect(green.executorKind).toBe('green');
    expect(judgeNextMove({ stopReason: 'no-progress', prState: 'MERGED', pr: 77, failures: { alternative: 3 } }).move).toBe('propose-green');
    expect(judgeNextMove({ failures: stale }).move).toBe('wait');
    expect(judgeNextMove({ stopReason: 'converged', prState: 'OPEN', pr: 1, failures: stale }).move).toBe('wait');
    // 병합 근거는 같은 수 한도도 넘는다.
    expect(judgeNextMove({ stopReason: 'converged', prState: 'MERGED', pr: 1, failures: { 'propose-green': 5 } }).move).toBe('propose-green');
  });

  test('대안 실패 → 결정 카드 승격은 같은 실패 흐름(재발사 계열·한도 소진 수)에서만', () => {
    // 재발사 계열은 대안 실패가 있으면 카드.
    expect(judgeNextMove({ stopReason: 'provider-exhausted', failures: { alternative: 1 } }).move).toBe('decision-card');
    expect(judgeNextMove({ stopReason: 'handed-off-to-salvage', failures: { alternative: 1 } }).move).toBe('decision-card');
    // 새로 관측된 리뷰 통과 → 착지 제안은 지난 대안 실패로 막히지 않는다.
    expect(judgeNextMove({ stopReason: 'needs-human', review: 'pass', failures: { alternative: 1 } }).move).toBe('propose-land');
    expect(judgeNextMove({ stopReason: 'needs-human', failures: { alternative: 1 } }).move).toBe('review');
    // 리뷰가 한도만큼 실패하고 대안도 실패했으면 카드(무한 대안 반복 방지).
    expect(judgeNextMove({ stopReason: 'needs-human', failures: { review: 2 } }).move).toBe('alternative');
    expect(judgeNextMove({ stopReason: 'needs-human', failures: { review: 2, alternative: 1 } }).move).toBe('decision-card');
  });

  test('대기는 실패 누적으로 대안이 되지 않는다', () => {
    expect(judgeNextMove({ failures: { wait: 5 } }).move).toBe('wait');
  });
});

describe('§A9 G2 — 재발사 갈래가 실행부에 구분되어 넘어간다', () => {
  test('narrow · wait · salvage · alternative 는 retry 이되 variant 가 다르다', () => {
    expect(judgeNextMove({ stopReason: 'no-progress' }).executorVariant).toBe('narrow');
    expect(judgeNextMove({ stopReason: 'provider-exhausted' }).executorVariant).toBe('wait');
    expect(judgeNextMove({ stopReason: 'handed-off-to-salvage' }).executorVariant).toBe('salvage');
    expect(judgeNextMove({ stopReason: 'no-progress', failures: { 'narrow-relaunch': 2 } }).executorVariant).toBe('alternative');
    expect(judgeNextMove({ stopReason: 'converged', prState: 'MERGED', pr: 1 }).executorVariant).toBeUndefined();
  });
});

describe('종결 종류 — code-pr 밖은 확인 증거로 종결 (RFC-loop-agent-map §A4b③)', () => {
  test('증거 ok → green 제안(근거 ref) · 증거 없음 → 확인 증거 대기 · ok=false → 좁혀 재발사', () => {
    const green = judgeNextMove({ stopReason: 'converged', completion: 'research-report', evidence: { ok: true, ref: 'out/report.md' } });
    expect(green.move).toBe('propose-green');
    expect(green.executorKind).toBe('green');
    expect(green.reason).toContain('out/report.md');
    const waiting = judgeNextMove({ stopReason: 'converged', completion: 'research-report' });
    expect(waiting.move).toBe('wait');
    expect(waiting.reason).toContain('확인 증거 대기');
    expect(judgeNextMove({ completion: 'ops-action' }).reason).toBe('확인 증거 대기 — ops-action');
    const failed = judgeNextMove({ stopReason: 'converged', completion: 'artifact', evidence: { ok: false, ref: 'a.png' } });
    expect(failed.move).toBe('narrow-relaunch');
    expect(failed.executorKind).toBe('retry');
    const blankRef = judgeNextMove({ stopReason: 'converged', completion: 'artifact', evidence: { ok: true, ref: '  ' } });
    expect(blankRef.move).toBe('wait');
    expect(blankRef.reason).toBe('확인 증거 대기 — artifact (ref 비어 있음)');
  });

  test('보존 — completion 생략·code-pr 은 종전 수·문면 그대로 · 증거가 없으면 종료 어휘 표가 그대로 산다', () => {
    for (const completion of [undefined, 'code-pr'] as const) {
      expect(judgeNextMove({ stopReason: 'converged', completion })).toEqual(judgeNextMove({ stopReason: 'converged' }));
      expect(judgeNextMove({ stopReason: 'converged', completion }).reason).toBe('완주했으나 PR 병합 근거 대기');
      expect(judgeNextMove({ stopReason: 'converged', prState: 'MERGED', pr: 7, completion, evidence: { ok: false, ref: 'x' } }).move).toBe('propose-green');
    }
    expect(judgeNextMove({ stopReason: 'provider-exhausted', completion: 'watch-brief' }).move).toBe('wait-retry');
    expect(judgeNextMove({ stopReason: 'no-progress', completion: 'content' }).move).toBe('narrow-relaunch');
  });
});
