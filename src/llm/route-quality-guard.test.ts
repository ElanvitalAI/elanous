// ROUTER-QUALITY-GUARD-95 가드 시험 — jud-39614 mustFix ① shadow 대조 · ② task-type별 임계.
// RED 우선: 수리 전 이 파일의 단언은 전부 실패해야 한다(구현 커밋으로 GREEN).
// 기대값은 제품과 독립 리터럴 — 가드 상수·렌더 함수로 기대값을 만들지 않는다.
// 출처: #39641 — 큐 점수(0.97/0.99/0.60/0.93)·임계(전유형 0.95)·평가 횟수(1·2)는 이 PR의 가드 계약 리터럴(jud-39614 e00bc107ef1f · OP #132280 필수 1).

import { describe, expect, test } from 'bun:test';
import { decideGuardedRoute } from './route-quality-guard.js';

/** 큐 소비 evaluate — 호출 순서 기록. 큐 소진은 throw(과제당 평가 횟수 계약 위반을 크게). */
function queueEvaluator(queue: number[]): { calls: string[]; evaluate: (model: string) => number } {
  const calls: string[] = [];
  const evaluate = (model: string): number => {
    calls.push(model);
    const score = queue.shift();
    if (score === undefined) throw new Error(`evaluate queue exhausted at call ${calls.length}`);
    return score;
  };
  return { calls, evaluate };
}

describe('① shadow 대조 — 통과 과제도 프리미엄 평가 1회(과제당 evaluate 정확히 2)', () => {
  test('통과 — 호출 순서 [가벼운, 프리미엄] · shadowScore·shadowDelta 근거가 결정에 남는다', async () => {
    const q = queueEvaluator([0.97, 0.99]);
    const d = await decideGuardedRoute({
      lightweight: 'light-mini', premium: 'premium-max', evaluate: q.evaluate, taskType: 'chat',
    });
    expect(q.calls).toEqual(['light-mini', 'premium-max']);
    expect(d.model).toBe('light-mini');
    expect(d.escalated).toBe(false);
    expect(d.qualityScore).toBe(0.97);
    expect(d.firstAttemptScore).toBe(0.97);
    expect(d.shadowScore).toBe(0.99);
    expect(d.shadowDelta).toBeCloseTo(0.02, 10);
    expect(d.taskType).toBe('chat');
    expect(d.appliedFloor).toBe(0.95);
  });

  test('게이트 실패 — shadow 결과를 인도 점수로 재사용한다(프리미엄 추가 evaluate 0 · 호출 정확히 2)', async () => {
    const q = queueEvaluator([0.60, 0.99]);
    const d = await decideGuardedRoute({
      lightweight: 'light-mini', premium: 'premium-max', evaluate: q.evaluate, taskType: 'codegen',
    });
    expect(q.calls).toEqual(['light-mini', 'premium-max']);
    expect(d.model).toBe('premium-max');
    expect(d.escalated).toBe(true);
    expect(d.qualityScore).toBe(0.99);
    expect(d.firstAttemptScore).toBe(0.60);
    expect(d.shadowScore).toBe(0.99);
  });

  test('shadow:false — 통과 시 프리미엄 평가 없음(호출 1) · 실패 시에만 평가(호출 2) · shadowScore null', async () => {
    const pass = queueEvaluator([0.97]);
    const dPass = await decideGuardedRoute({
      lightweight: 'light-mini', premium: 'premium-max', evaluate: pass.evaluate, taskType: 'chat', shadow: false,
    });
    expect(pass.calls).toEqual(['light-mini']);
    expect(dPass.model).toBe('light-mini');
    expect(dPass.shadowScore).toBeNull();
    expect(dPass.shadowDelta).toBeNull();
    const fail = queueEvaluator([0.60, 0.99]);
    const dFail = await decideGuardedRoute({
      lightweight: 'light-mini', premium: 'premium-max', evaluate: fail.evaluate, taskType: 'chat', shadow: false,
    });
    expect(fail.calls).toEqual(['light-mini', 'premium-max']);
    expect(dFail.model).toBe('premium-max');
    expect(dFail.escalated).toBe(true);
    expect(dFail.qualityScore).toBe(0.99);
    expect(dFail.shadowScore).toBeNull();
  });
});

describe('② task-type별 임계 — 같은 점수가 유형별로 갈린다', () => {
  test('floors 바닥 0.90은 입력 거부(전유형 ≥0.95 강제 · OP #132280) · bundle 0.93은 0.95 바닥에서 상향', async () => {
    const lowFloor = queueEvaluator([0.93, 0.99]);
    await expect(decideGuardedRoute({
      lightweight: 'light-mini', premium: 'premium-max', evaluate: lowFloor.evaluate, taskType: 'bundle', floors: { bundle: 0.90 },
    })).rejects.toThrow();
    const escalated = queueEvaluator([0.93, 0.99]);
    const dEscalated = await decideGuardedRoute({
      lightweight: 'light-mini', premium: 'premium-max', evaluate: escalated.evaluate, taskType: 'bundle', floors: { bundle: 0.95 },
    });
    expect(dEscalated.model).toBe('premium-max');
    expect(dEscalated.escalated).toBe(true);
    expect(dEscalated.qualityScore).toBe(0.99);
    expect(dEscalated.appliedFloor).toBe(0.95);
  });

  test('미등록 유형 폐백 0.95 — 근거 열(taskType·appliedFloor)이 판정에 남는다', async () => {
    const q = queueEvaluator([0.94, 0.99]);
    const d = await decideGuardedRoute({
      lightweight: 'light-mini', premium: 'premium-max', evaluate: q.evaluate, taskType: 'unknown-type', floors: { chat: 0.96 },
    });
    expect(d.taskType).toBe('unknown-type');
    expect(d.appliedFloor).toBe(0.95);
    expect(d.escalated).toBe(true);
    expect(d.qualityScore).toBe(0.99);
    expect(d.firstAttemptScore).toBe(0.94);
  });
});