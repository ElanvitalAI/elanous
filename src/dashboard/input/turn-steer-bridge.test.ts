// TUI typeahead 큐 ↔ 턴 «안» 주입 레지스트리 — ⛔ 같은 발화는 «한 번만» 모델에 들어간다(10-14 중복 수리).
import { beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { debug } from '../../debug/log.js';
import {
  applyTurnTypeaheadKey,
  createTurnTypeaheadState,
  type TurnTypeaheadState,
} from '../../chat/turn-typeahead.js';
import { buildInterjectionMessage } from '../../chat/interjection.js';
import {
  clearPendingUserInput,
  drainPendingUserInput,
  enqueuePendingUserInput,
  pendingUserInputCount,
} from '../../session/pending-input.js';
import {
  handoffTurnTypeaheadAtTurnEnd,
  releaseTurnTypeaheadPending,
  steerLastTurnTypeaheadSubmission,
  type SteerDrainedEvent,
  type TurnTypeaheadRef,
} from './turn-steer-bridge.js';

const SID = 'steer-bridge-s1';

function typeAndEnter(ref: TurnTypeaheadRef, text: string, events: SteerDrainedEvent[]): string | null {
  let state: TurnTypeaheadState = ref.state;
  for (const ch of [...text]) state = applyTurnTypeaheadKey(state, { name: ch === ' ' ? 'space' : ch }).state;
  const entered = applyTurnTypeaheadKey(state, { name: 'enter' });
  expect(entered.submissionDisposition).toBe('fifo');
  ref.state = entered.state;
  return steerLastTurnTypeaheadSubmission(ref, SID, (event) => events.push(event));
}

/**
 * 백엔드 대역 — 모델이 «실제로 받는» user 문면을 모은다. 두 입구만 있다(그 밖의 길로는 모델에 안 닿는다):
 *   ⓐ 새 프롬프트 = composer 가 Enter 로 제출한 글(턴 첫 바퀴)
 *   ⓑ 도는 턴 둘째 바퀴부터 = `drainPendingUserInput` 배수 → `buildInterjectionMessage` 문면
 *      (llm.ts 도구 루프 `turn > 0 && opts.drainPendingUserInput` 과 같은 꼴 · run-core-turn 이 그 sid 로 배선).
 * ⚠️ 경계: 대시보드 본체(`showDashboard`)·실 LLM 도구 루프는 시험에서 세우지 못한다(터미널·공급자 필요) —
 *   그래서 배수·문면 짓기는 «실제 함수»를 부르고, 루프 바퀴만 이 대역이 돈다.
 */
class BackendDouble {
  readonly received: string[] = [];
  startTurn(prompt: string): void { this.received.push(prompt); }
  /** 도구 경계 하나(turn>0 바퀴 시작) — 실제 레지스트리를 배수한다. */
  boundary(): void {
    const message = buildInterjectionMessage(drainPendingUserInput(SID), 'mid-turn');
    if (message) this.received.push(message);
  }
  /** 그 발화가 모델에 «몇 번» 닿았나 — 받은 문면 전체에서 센다. */
  count(text: string): number {
    return this.received.reduce((n, body) => n + body.split(text).length - 1, 0);
  }
}

/**
 * 턴 종료 핸드오프 — 대시보드가 부르는 «그 함수»(`handoffTurnTypeaheadAtTurnEnd`)를 부른다.
 * Enter 콜백은 키 대기열에 Enter 를 넣고(= `injectKey`), composer 대역이 `initialText = nextInitial` 로 열려
 * 그 Enter 를 읽으면 제출해 백엔드 새 턴으로 보낸다. ⭐ Enter 가 안 들어오면 제출도 없다.
 */
function turnEnd(ref: TurnTypeaheadRef, backend: BackendDouble, interrupted = false) {
  const keys: string[] = [];
  const drained = handoffTurnTypeaheadAtTurnEnd(ref, undefined, { interrupted }, () => { keys.push('enter'); });
  const entersInjected = keys.length;
  let submitted: string | undefined;
  if (keys.shift() === 'enter' && drained.nextInitial) {
    submitted = drained.nextInitial;
    backend.startTurn(submitted);
  }
  return { ...drained, submitted, entersInjected };
}

describe('turn-steer-bridge — 같은 발화는 모델에 «정확히 한 번»', () => {
  beforeEach(() => clearPendingUserInput(SID));

  test('도구 호출 없는 마지막 바퀴: 턴 종료 Enter 로 새 프롬프트에 한 번 · 다음 턴 둘째 바퀴 배수엔 없다', () => {
    const ref: TurnTypeaheadRef = { state: createTurnTypeaheadState() };
    const backend = new BackendDouble();
    const events: SteerDrainedEvent[] = [];
    backend.startTurn('first prompt');
    // 턴 중 Enter — 그런데 그 뒤 바퀴에 도구 호출이 없어 경계 배수 기회가 없다.
    expect(typeAndEnter(ref, 'END-MARK', events)).not.toBeNull();
    expect(pendingUserInputCount(SID)).toBe(1);

    const handoff = turnEnd(ref, backend);
    expect(handoff.entersInjected).toBe(1);
    expect(handoff.submitted).toBe('END-MARK');
    expect(backend.received).toEqual(['first prompt', 'END-MARK']);

    // 그 새 프롬프트 턴의 둘째 바퀴(turn>0) 배수 — 같은 발화가 다시 붙지 않는다.
    backend.boundary();
    expect(backend.count('END-MARK')).toBe(1);
    expect(backend.received).toHaveLength(2);
    expect(events).toEqual([]);
  });

  test('도구 경계에서 배수된 발화는 그 바퀴에 한 번 들어가고, 턴 종료엔 Enter 도 제출도 없다', () => {
    const ref: TurnTypeaheadRef = { state: createTurnTypeaheadState() };
    const backend = new BackendDouble();
    const events: SteerDrainedEvent[] = [];
    backend.startTurn('first prompt');
    typeAndEnter(ref, 'MID-MARK', events);
    backend.boundary();
    expect(events).toEqual([{ texts: ['MID-MARK'], remaining: 0 }]);

    const handoff = turnEnd(ref, backend);
    expect(handoff.entersInjected).toBe(0);
    expect(handoff.submitted).toBeUndefined();
    backend.boundary();
    expect(backend.count('MID-MARK')).toBe(1);
  });

  test('Ctrl+↑ 로 되꺼낸 발화(전부)는 고치기 전 문면으로 모델에 가지 않는다 · 남의 항목은 남는다', () => {
    const ref: TurnTypeaheadRef = { state: createTurnTypeaheadState() };
    const backend = new BackendDouble();
    const events: SteerDrainedEvent[] = [];
    enqueuePendingUserInput(SID, 'CONTROL-MEMO');
    typeAndEnter(ref, 'FIRST-MARK', events);
    typeAndEnter(ref, 'OOPS-MARK', events);
    expect(pendingUserInputCount(SID)).toBe(3);

    const recalled = applyTurnTypeaheadKey(ref.state, { name: 'up', ctrl: true });
    expect(recalled.consumed).toBe(true);
    expect(recalled.releasedPendingIds).toHaveLength(2);
    ref.state = recalled.state;
    releaseTurnTypeaheadPending(recalled.releasedPendingIds, 'recalled');
    // 입력 순서대로 전부 꺼낸다(Claude Code 동형).
    expect(ref.state.buffer).toBe('FIRST-MARK\nOOPS-MARK');
    expect(pendingUserInputCount(SID)).toBe(1);

    backend.boundary();
    expect(turnEnd(ref, backend).entersInjected).toBe(0);
    backend.boundary();
    expect(backend.count('FIRST-MARK')).toBe(0);
    expect(backend.count('OOPS-MARK')).toBe(0);
    expect(backend.count('CONTROL-MEMO')).toBe(1);
    expect(events).toEqual([{ texts: [], remaining: 0 }]);
  });

  test('Ctrl+↑ 로 하나뿐인 항목을 되꺼내면 대기 수가 0이다', () => {
    const ref: TurnTypeaheadRef = { state: createTurnTypeaheadState() };
    typeAndEnter(ref, 'only', []);
    const recalled = applyTurnTypeaheadKey(ref.state, { name: 'up', ctrl: true });
    ref.state = recalled.state;
    releaseTurnTypeaheadPending(recalled.releasedPendingIds);
    expect(pendingUserInputCount(SID)).toBe(0);
  });

  test('Esc 중단 뒤 composer 로 복원된 발화는 Enter 없이 남고 다음 턴 배수에도 없다', () => {
    const ref: TurnTypeaheadRef = { state: createTurnTypeaheadState() };
    const backend = new BackendDouble();
    typeAndEnter(ref, 'AA-MARK', []);
    typeAndEnter(ref, 'BB-MARK', []);
    const restored = turnEnd(ref, backend, true);
    expect(restored.entersInjected).toBe(0);
    expect(restored.submitted).toBeUndefined();
    expect(restored.nextInitial).toBe('AA-MARK\nBB-MARK');
    expect(pendingUserInputCount(SID)).toBe(0);
    backend.boundary();
    expect(backend.received).toEqual([]);
  });

  test('슬래시는 턴 중 주입에 안 들어간다(턴 종료 Enter 로만 제출)', () => {
    const ref: TurnTypeaheadRef = { state: createTurnTypeaheadState() };
    const backend = new BackendDouble();
    expect(typeAndEnter(ref, '/compact', [])).toBeNull();
    expect(pendingUserInputCount(SID)).toBe(0);
    backend.boundary();
    const handoff = turnEnd(ref, backend);
    expect(handoff.entersInjected).toBe(1);
    expect(backend.received).toEqual(['/compact']);
  });

  test('배수 통지는 id 로 짝짓는다 — 같은 버킷의 goal-loop 메모 때문에 엉뚱한 대기 발화가 떨어지지 않는다', () => {
    const ref: TurnTypeaheadRef = { state: createTurnTypeaheadState() };
    const backend = new BackendDouble();
    const events: SteerDrainedEvent[] = [];
    enqueuePendingUserInput(SID, 'control memo');
    typeAndEnter(ref, 'A-MARK', events);
    // 레지스트리에 안 넣는 항목(슬래시)이 큐 앞에 끼어 있어도 짝이 어긋나지 않는다.
    typeAndEnter(ref, '/model', events);
    typeAndEnter(ref, 'B-MARK', events);

    backend.boundary();
    expect(events).toEqual([{ texts: ['A-MARK', 'B-MARK'], remaining: 1 }]);
    expect(ref.state.queuedSubmissions).toEqual(['/model']);
    expect(turnEnd(ref, backend).submitted).toBe('/model');
    backend.boundary();
    expect(backend.count('A-MARK')).toBe(1);
    expect(backend.count('B-MARK')).toBe(1);
    expect(backend.count('control memo')).toBe(1);
  });

  test('세션이 없으면 레지스트리에 안 넣고 턴 종료 FIFO 로만 간다', () => {
    const ref: TurnTypeaheadRef = { state: createTurnTypeaheadState() };
    ref.state = applyTurnTypeaheadKey(applyTurnTypeaheadKey(ref.state, { name: 'x' }).state, { name: 'enter' }).state;
    expect(steerLastTurnTypeaheadSubmission(ref, null, () => {})).toBeNull();
    expect(ref.state.queuedPendingIds).toBeUndefined();
  });
});

describe('turn-steer-bridge — 해제 관측(RFC v2 P1 ⓑⓒ)', () => {
  beforeEach(() => clearPendingUserInput(SID));

  test('승격·되꺼내기·Esc 복원이 각자 이유로 «실제로» 레지스트리에서 빠진 것을 남긴다', () => {
    const spy = spyOn(debug, 'log');
    try {
      const ref: TurnTypeaheadRef = { state: createTurnTypeaheadState() };
      const backend = new BackendDouble();
      const midId = typeAndEnter(ref, 'mid', [])!;
      backend.boundary();
      const endId = typeAndEnter(ref, 'end', [])!;
      turnEnd(ref, backend);
      backend.boundary();
      const recalledId = typeAndEnter(ref, 'oops', [])!;
      const recalled = applyTurnTypeaheadKey(ref.state, { name: 'up', ctrl: true });
      ref.state = recalled.state;
      releaseTurnTypeaheadPending(recalled.releasedPendingIds, 'recalled');
      ref.state = createTurnTypeaheadState();
      const escId = typeAndEnter(ref, 'esc', [])!;
      turnEnd(ref, backend, true);
      backend.boundary();

      const removed = spy.mock.calls.filter(([c, e]) => c === 'llm.interjection' && e === 'removed')
        .map(([, , data]) => (data as { reason: string; ids: string[] }));
      expect(removed).toEqual([
        expect.objectContaining({ ids: [endId], reason: 'submitted-as-prompt' }),
        expect.objectContaining({ ids: [recalledId], reason: 'recalled' }),
        expect.objectContaining({ ids: [escId], reason: 'restored-after-interrupt' }),
      ]);
      const drainedIds = spy.mock.calls.filter(([c, e]) => c === 'llm.interjection' && e === 'drained')
        .flatMap(([, , data]) => (data as { ids: string[] }).ids);
      expect(drainedIds).toEqual([midId]);
      expect(spy.mock.calls.some(([c, e, d]) => c === 'dashboard.turn-typeahead' && e === 'submitted-as-prompt' && (d as { id: string }).id === endId)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
