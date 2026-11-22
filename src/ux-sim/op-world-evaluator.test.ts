import { describe, expect, test } from 'bun:test';
import { observeOpWorldReplay, observeOpWorldReplayDecisions, OP_WORLD_REPLAY_DISPOSITIONS } from './op-world-evaluator.js';
import { compareOpWorldBuiltInDispositions } from './op-world-score.js';
import { opWorldAnswerCases } from './op-world-replay.js';
import type { OpWorldAction, OpWorldActionResult } from './op-on-eln-world.js';

const [caseOne] = opWorldAnswerCases('replay-answer-key-1');
if (!caseOne) throw new Error('expected at least one replay-answer-key-1 case');

/** 사례 instruction 은 `${situation} A: ${optionA} B: ${optionB}` 형식으로 두 보기를 박는다. */
function optionTextsOf(instruction: string): { optionA: string; optionB: string } {
  const aMarker = instruction.indexOf(' A: ');
  const bMarker = instruction.indexOf(' B: ');
  if (aMarker === -1 || bMarker === -1 || bMarker < aMarker) {
    throw new Error('expected A/B option markers in the case instruction');
  }
  return { optionA: instruction.slice(aMarker + 4, bMarker), optionB: instruction.slice(bMarker + 4) };
}

const options = optionTextsOf(caseOne.order.instruction);

interface Choice { choice: 'A' | 'B'; evidenceId: string }

function reportResult(overrides: {
  reason?: string;
  evidence?: readonly string[];
  choice?: Choice;
  status?: OpWorldActionResult['status'];
} = {}): OpWorldActionResult {
  return {
    action: {
      type: 'report',
      target: caseOne.order.task,
      reason: overrides.reason ?? `A: ${options.optionA}`,
      evidence: overrides.evidence ?? [caseOne.order.id],
      ...(overrides.choice ? { choice: overrides.choice } : {}),
    },
    status: overrides.status ?? 'accepted',
    detail: 'simulated replay report',
  };
}

function observedOf(results: readonly OpWorldActionResult[]): string | null | undefined {
  const [comparison] = observeOpWorldReplayDecisions(caseOne.sceneId, results);
  return comparison?.observedDisposition;
}

describe('observeOpWorldReplayDecisions — 구조화 choice 필드 계약 (OP #127270)', () => {
  // 계약: 관측 처분은 결정 종류(report)·배정 대상(order.task)·근거 ID(order.id) 게이트 뒤에서
  // 오직 구조화된 choice 필드({choice:'A'|'B', evidenceId}) 로만 결정된다. reason 산문 해석 금지.

  test('부정문 reason 이 보기 A 원문을 포함해도 choice 필드가 없으면 미관측(null) — includes 오판 폐기', () => {
    const reason = `A를 선택하지 않는다 — ${options.optionA}는 조건이 맞지 않다`;
    expect(observedOf([reportResult({ reason })])).toBeNull();
  });

  test('choice 필드가 있으면 reason 모양과 무관하게 그 보기로 관측한다', () => {
    expect(observedOf([
      reportResult({ choice: { choice: 'A', evidenceId: caseOne.order.id }, reason: '짧은 표지' }),
    ])).toBe('A');
    expect(observedOf([
      reportResult({ choice: { choice: 'B', evidenceId: caseOne.order.id }, reason: `A: ${options.optionA}도 검토했다` }),
    ])).toBe('B');
  });

  test('choice.evidenceId 가 지시 ID와 다른 보고는 관측에서 제외된다(null)', () => {
    expect(observedOf([
      reportResult({ choice: { choice: 'A', evidenceId: 'other-order' } }),
    ])).toBeNull();
  });

  test('evidence 에 지시 ID가 없는 보고는 관측에서 제외된다(null)', () => {
    expect(observedOf([
      reportResult({ choice: { choice: 'A', evidenceId: caseOne.order.id }, evidence: ['other-evidence'] }),
    ])).toBeNull();
  });

  test('denied 보고는 관측하지 않는다(null)', () => {
    expect(observedOf([
      reportResult({ choice: { choice: 'A', evidenceId: caseOne.order.id }, status: 'denied' }),
    ])).toBeNull();
  });

  test('상충하는 두 관측(A/B)은 미관측(null)', () => {
    expect(observedOf([
      reportResult({ choice: { choice: 'A', evidenceId: caseOne.order.id } }),
      reportResult({ choice: { choice: 'B', evidenceId: caseOne.order.id } }),
    ])).toBeNull();
  });

  test('관측과 미관측 보고가 섞이면 미관측(null)', () => {
    expect(observedOf([
      reportResult({ choice: { choice: 'A', evidenceId: caseOne.order.id }, reason: '첫째 보고' }),
      reportResult({ reason: `A: ${options.optionA}` }),
    ])).toBeNull();
  });

  test('같은 보기를 가리키는 두 관측은 그 보기로 관측한다', () => {
    expect(observedOf([
      reportResult({ choice: { choice: 'A', evidenceId: caseOne.order.id }, reason: '첫째 보고' }),
      reportResult({ choice: { choice: 'A', evidenceId: caseOne.order.id }, reason: '둘째 보고' }),
    ])).toBe('A');
  });
});

describe('observeOpWorldReplay — 구조화 disposition 처분 (terra mustFix ② · #39377)', () => {
  // 계약: 자유형 reason 정규식 채점 금지. 재현 처분은 명시적 disposition 필드가
  // 해당 장면의 열거 토큰(OP_WORLD_REPLAY_DISPOSITIONS)과 일치할 때만 관측된다.

  function replayResult(action: Partial<OpWorldAction> & Pick<OpWorldAction, 'type'>): OpWorldActionResult {
    return {
      action: {
        type: action.type,
        target: action.target ?? 'sim-pr-replay-gate',
        reason: action.reason ?? '재현 장면 처분',
        evidence: action.evidence ?? ['replay-order-gate'],
        ...(action.worker !== undefined ? { worker: action.worker } : {}),
        ...(action.disposition !== undefined ? { disposition: action.disposition } : {}),
      },
      status: 'accepted',
      detail: 'simulated replay outcome',
    };
  }

  test('부정문 reason 이 정규식 단어를 포함해도 disposition 필드가 없으면 null', () => {
    // «재검을 하지 않는다» — '재검'·'head' 가 들어 있어도 처분 필드가 없으면 미관측이어야 한다.
    expect(observeOpWorldReplay('replay-gate-stop', [replayResult({
      type: 'hold', target: 'sim-pr-replay-gate',
      reason: '현 head 재검은 하지 않는다 — 대신 착지를 유예한다',
    })])).toBeNull();
  });

  test('disposition 필드가 있으면 reason 산문과 무관하게 그 처분으로 관측한다', () => {
    expect(observeOpWorldReplay('replay-gate-stop', [replayResult({
      type: 'hold', target: 'sim-pr-replay-gate', reason: '보류',
      disposition: OP_WORLD_REPLAY_DISPOSITIONS['replay-gate-stop'],
    })])).toBe(OP_WORLD_REPLAY_DISPOSITIONS['replay-gate-stop']);
    expect(observeOpWorldReplay('replay-scoped-repair', [replayResult({
      type: 'assign', target: 'sim-replay-scoped-repair', reason: '범위 배정',
      disposition: OP_WORLD_REPLAY_DISPOSITIONS['replay-scoped-repair'],
    })])).toBe(OP_WORLD_REPLAY_DISPOSITIONS['replay-scoped-repair']);
    expect(observeOpWorldReplay('replay-direct-edit', [replayResult({
      type: 'assign', target: 'sim-replay-direct-edit', reason: '실행 경로 지정',
      disposition: OP_WORLD_REPLAY_DISPOSITIONS['replay-direct-edit'],
    })])).toBe(OP_WORLD_REPLAY_DISPOSITIONS['replay-direct-edit']);
  });

  test('열거 밖 disposition 문자열은 관측값으로 보존되어 불일치로 집계된다 (terra r4 mustFix 2)', () => {
    const observed = observeOpWorldReplay('replay-gate-stop', [replayResult({
      type: 'hold', target: 'sim-pr-replay-gate', reason: '현 head 대조가 필요하다',
      disposition: 'hold-fast',
    })]);
    // RED: 현재는 null → 실제 오판이 미관측으로 집계된다. 관측된 구조화 처분은 그대로 보존해야 한다.
    expect(observed).toBe('hold-fast');
    const summary = compareOpWorldBuiltInDispositions([{
      decisionId: 'op-mail:115549', sceneId: 'replay-gate-stop',
      expectedDisposition: OP_WORLD_REPLAY_DISPOSITIONS['replay-gate-stop'],
      observedDisposition: observed,
    }]);
    expect(summary.mismatched).toBe(1);
    expect(summary.unobserved).toBe(0);
    expect(summary.observed).toBe(1);
  });

  test('다른 장면의 토큰이면 관측값으로 보존되어 불일치로 판정된다 (terra r4 mustFix 2)', () => {
    const observed = observeOpWorldReplay('replay-scoped-repair', [replayResult({
      type: 'assign', target: 'sim-replay-scoped-repair', reason: '게이트 보류를 먼저 두고 대조한다',
      disposition: OP_WORLD_REPLAY_DISPOSITIONS['replay-gate-stop'],
    })]);
    // RED: 현재는 null → 미관측. 올바른 유형·대상의 구조화 처분은 보존해야 한다.
    expect(observed).toBe(OP_WORLD_REPLAY_DISPOSITIONS['replay-gate-stop']);
    const summary = compareOpWorldBuiltInDispositions([{
      decisionId: 'op-mail:116020', sceneId: 'replay-scoped-repair',
      expectedDisposition: OP_WORLD_REPLAY_DISPOSITIONS['replay-scoped-repair'],
      observedDisposition: observed,
    }]);
    expect(summary.mismatched).toBe(1);
    expect(summary.unobserved).toBe(0);
  });

  test('같은 유형·대상에 서로 다른 두 처분이 섞이면 특정 불가로 미관측(null) — 보수적 정책', () => {
    // choice 상충 정책(observeOpWorldReplayDecisions «상충하는 두 관측은 null») 과 같은 기준을 처분에도 적용.
    expect(observeOpWorldReplay('replay-direct-edit', [
      replayResult({
        type: 'assign', target: 'sim-replay-direct-edit', reason: '첫째 처분',
        disposition: OP_WORLD_REPLAY_DISPOSITIONS['replay-direct-edit'],
      }),
      replayResult({
        type: 'assign', target: 'sim-replay-direct-edit', reason: '둘째 처분',
        disposition: OP_WORLD_REPLAY_DISPOSITIONS['replay-scoped-repair'],
      }),
    ])).toBeNull();
  });

  test('부정문 reason 에 올바른 disposition 이면 처분으로 관측한다', () => {
    expect(observeOpWorldReplay('replay-gate-stop', [replayResult({
      type: 'hold', target: 'sim-pr-replay-gate',
      reason: '재검 대상이 아니다 — 처분은 disposition 필드로 명시했다',
      disposition: OP_WORLD_REPLAY_DISPOSITIONS['replay-gate-stop'],
    })])).toBe(OP_WORLD_REPLAY_DISPOSITIONS['replay-gate-stop']);
  });
});
