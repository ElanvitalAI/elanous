// «지금 밀어 넣기»·큐 상태 표시 — 대표 10-14 «현재 작업 안으로 밀어 넣기 · Claude Code 처럼 중간 인터럽트».
import { beforeEach, describe, expect, test } from 'bun:test';
import {
  applyTurnTypeaheadKey,
  createTurnTypeaheadState,
  drainTurnTypeaheadOnce,
  renderTurnTypeaheadQueueRow,
  type TurnTypeaheadState,
} from '../../chat/turn-typeahead.js';
import { canInterruptRunningTools, toolInterruptBehavior } from '../../chat/tool-interrupt-behavior.js';
import { buildInterjectionMessage } from '../../chat/interjection.js';
import {
  clearPendingUserInput,
  drainPendingUserInput,
  enqueuePendingUserInput,
  pendingUserInputCount,
} from '../../session/pending-input.js';
import {
  consumeTurnEndInterrupted,
  decidePushNow,
  handoffTurnTypeaheadAtTurnEnd,
  runTurnTypeaheadPushNow,
  steerLastTurnTypeaheadSubmission,
  type TurnTypeaheadRef,
} from './turn-steer-bridge.js';

const SID = 'steer-push-now-s1';

function typeAndEnter(ref: TurnTypeaheadRef, text: string, sid: string | null = SID): void {
  let state: TurnTypeaheadState = ref.state;
  for (const ch of [...text]) state = applyTurnTypeaheadKey(state, { name: ch === ' ' ? 'space' : ch }).state;
  ref.state = applyTurnTypeaheadKey(state, { name: 'enter' }).state;
  steerLastTurnTypeaheadSubmission(ref, sid, () => {});
}

/** 백엔드 대역 — 모델이 «실제로 받는» user 문면을 모은다(turn-steer-bridge.test 와 같은 두 입구). */
class BackendDouble {
  readonly received: string[] = [];
  startTurn(prompt: string): void { this.received.push(prompt); }
  boundary(): void {
    const message = buildInterjectionMessage(drainPendingUserInput(SID), 'mid-turn');
    if (message) this.received.push(message);
  }
  count(text: string): number {
    return this.received.reduce((n, body) => n + body.split(text).length - 1, 0);
  }
}

/** 턴 종료 — 대시보드가 부르는 `handoffTurnTypeaheadAtTurnEnd` 를 부르고, 주입된 Enter 만 새 프롬프트로 제출한다. */
function turnEnd(ref: TurnTypeaheadRef, backend: BackendDouble, interrupted: boolean) {
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

describe('도구 선언 — interruptBehavior', () => {
  test('기본은 block 이고 읽기·대기 도구만 cancel 이다', () => {
    expect(toolInterruptBehavior('Read')).toBe('cancel');
    expect(toolInterruptBehavior('AgentOutput')).toBe('cancel');
    expect(toolInterruptBehavior('Bash')).toBe('block');
    expect(toolInterruptBehavior('Edit')).toBe('block');
    expect(toolInterruptBehavior('SomethingNew')).toBe('block');
  });

  test('전부 cancel 일 때만 끊을 수 있다 · 도는 도구가 없으면 끊을 수 있다', () => {
    expect(canInterruptRunningTools([])).toEqual({ ok: true, blocking: [] });
    expect(canInterruptRunningTools(['Read', 'Grep'])).toEqual({ ok: true, blocking: [] });
    expect(canInterruptRunningTools(['Read', 'Bash', 'Bash'])).toEqual({ ok: false, blocking: ['Bash'] });
  });
});

describe('큐 상태 표시', () => {
  beforeEach(() => clearPendingUserInput(SID));

  test('↳ 다음 도구 경계 / ⏳ 대기(응답 뒤) / ✓ 넣음 — 그리고 턴이 끝나면 지워진다', () => {
    const ref: TurnTypeaheadRef = { state: createTurnTypeaheadState() };
    typeAndEnter(ref, 'go');
    expect(renderTurnTypeaheadQueueRow(ref.state, 120))
      .toBe('↳ 다음 도구 경계에 넣음 1건 · "go" · Ctrl+↑ 되꺼내기 · 빈 Enter 지금 밀어 넣기');

    typeAndEnter(ref, '/compact');
    expect(renderTurnTypeaheadQueueRow(ref.state, 120))
      .toBe('↳ 다음 도구 경계에 넣음 1건 · ⏳ 대기(응답 뒤) 1건 · "go" · Ctrl+↑ 되꺼내기 · 빈 Enter 지금 밀어 넣기');

    expect(drainPendingUserInput(SID)).toEqual(['go']);
    expect(renderTurnTypeaheadQueueRow(ref.state, 120))
      .toBe('⏳ 대기(응답 뒤) 1건 · "/compact" · Ctrl+↑ 되꺼내기 · 빈 Enter 지금 밀어 넣기');

    const end = drainTurnTypeaheadOnce(ref.state, undefined);
    ref.state = end.state;
    expect(end.nextInitial).toBe('/compact');
    expect(renderTurnTypeaheadQueueRow(ref.state, 120)).toBeNull();
  });

  test('큐가 다 들어가면 «✓ 넣음» 줄이 남고 턴 종료에 지워진다', () => {
    const ref: TurnTypeaheadRef = { state: createTurnTypeaheadState() };
    typeAndEnter(ref, 'a');
    typeAndEnter(ref, 'b');
    drainPendingUserInput(SID);
    expect(renderTurnTypeaheadQueueRow(ref.state, 120)).toBe('✓ 넣음 2건 · 도는 턴에 이어서 반영');
    ref.state = drainTurnTypeaheadOnce(ref.state, undefined).state;
    expect(renderTurnTypeaheadQueueRow(ref.state, 120)).toBeNull();
  });
});

describe('«지금 밀어 넣기»', () => {
  beforeEach(() => clearPendingUserInput(SID));

  test('빈 Enter 는 대기 항목이 있을 때만 요청이 된다', () => {
    const ref: TurnTypeaheadRef = { state: createTurnTypeaheadState() };
    expect(applyTurnTypeaheadKey(ref.state, { name: 'enter' }).consumed).toBe(false);
    typeAndEnter(ref, 'now');
    expect(applyTurnTypeaheadKey(ref.state, { name: 'enter' }).pushNowRequested).toBe(true);
  });

  test('판정: 비면 nothing · 끊을 수 있으면 interrupt · 아니면 priority', () => {
    const ref: TurnTypeaheadRef = { state: createTurnTypeaheadState() };
    expect(decidePushNow(ref.state, [])).toEqual({ kind: 'nothing' });
    typeAndEnter(ref, 'x');
    expect(decidePushNow(ref.state, [])).toEqual({ kind: 'interrupt', runningTools: [] });
    expect(decidePushNow(ref.state, ['Grep', 'Read'])).toEqual({ kind: 'interrupt', runningTools: ['Grep', 'Read'] });
    expect(decidePushNow(ref.state, ['Read', 'Bash'])).toEqual({ kind: 'priority', blockingTools: ['Bash'] });
  });

  test('interrupt: 도는 Read 위 빈 Enter → 턴만 끊고, 턴 종료가 Enter 를 주입해 그 발화가 새 프롬프트로 «정확히 한 번» 간다', () => {
    // ⭐ 대시보드가 부르는 «그 함수»들만 잇는다 — 키 판정(applyTurnTypeaheadKey) → runTurnTypeaheadPushNow →
    //   consumeTurnEndInterrupted → handoffTurnTypeaheadAtTurnEnd(Enter 주입 콜백). 상태를 손으로 만들지 않는다.
    //   대시보드 본체(showDashboard)는 시험에서 못 세운다(터미널·공급자) — 배선은 turn-typeahead.test 의 소스 단언이 문다.
    const ref: TurnTypeaheadRef = { state: createTurnTypeaheadState() };
    const steerInterruptRef = { pending: false };
    const abortCtrl = new AbortController();
    const backend = new BackendDouble();
    backend.startTurn('Read 로 파일을 읽어 줘');
    typeAndEnter(ref, 'PUSH-MARK');
    expect(pendingUserInputCount(SID)).toBe(1);

    // 빈 Enter — 대기 항목이 있으니 «지금 밀어 넣기» 요청이 된다.
    const key = applyTurnTypeaheadKey(ref.state, { name: 'enter' });
    expect(key.pushNowRequested).toBe(true);
    ref.state = key.state;

    const notices: string[] = [];
    // 대시보드와 같은 배선: 표지를 세우고 턴만 끊는다.
    const decision = runTurnTypeaheadPushNow(ref, {
      runningToolNames: () => ['Read'],
      interruptTurn: () => { steerInterruptRef.pending = true; abortCtrl.abort('elanous:turn-abort/turn-only'); },
      pushNotice: (line) => notices.push(line),
    });
    expect(decision).toEqual({ kind: 'interrupt', runningTools: ['Read'] });
    expect(abortCtrl.signal.aborted).toBe(true);
    expect(notices[0]).toContain('지금 밀어 넣기');

    // 끊긴 턴의 최종 상태는 interrupted 다 — 표지 때문에 «중단 복원»이 아니라 제출로 간다.
    const interrupted = consumeTurnEndInterrupted('interrupted', steerInterruptRef);
    expect(interrupted).toBe(false);
    expect(steerInterruptRef.pending).toBe(false);
    const end = turnEnd(ref, backend, interrupted);
    expect(end.entersInjected).toBe(1);
    expect(end.submitted).toBe('PUSH-MARK');
    expect(pendingUserInputCount(SID)).toBe(0);
    // 다음 턴(제출된 프롬프트)의 둘째 바퀴 — 같은 발화가 또 들어가지 않는다.
    backend.boundary();
    expect(backend.count('PUSH-MARK')).toBe(1);
    expect(ref.state.queuedSubmissions).toEqual([]);
  });

  test('대조: 표지 없이 Esc 로 끊긴 턴은 Enter 를 주입하지 않고 composer 로 복원한다(백엔드 0회)', () => {
    const ref: TurnTypeaheadRef = { state: createTurnTypeaheadState() };
    const backend = new BackendDouble();
    typeAndEnter(ref, 'ESC-MARK');
    const interrupted = consumeTurnEndInterrupted('interrupted', { pending: false });
    expect(interrupted).toBe(true);
    const end = turnEnd(ref, backend, interrupted);
    expect(end.entersInjected).toBe(0);
    expect(end.nextInitial).toBe('ESC-MARK');
    backend.boundary();
    expect(backend.count('ESC-MARK')).toBe(0);
  });

  test('표지 없이 Esc 로 끊긴 턴은 그대로 «중단 복원»이다', () => {
    const steerInterruptRef = { pending: false };
    expect(consumeTurnEndInterrupted('interrupted', steerInterruptRef)).toBe(true);
    expect(consumeTurnEndInterrupted('completed', { pending: true })).toBe(false);
  });

  test('deferred: 끊을 수 없고 경계에 넣을 항목도 없으면(슬래시뿐) 최우선이라고 알리지 않는다', () => {
    const ref: TurnTypeaheadRef = { state: createTurnTypeaheadState() };
    typeAndEnter(ref, '/compact');
    const notices: string[] = [];
    const decision = runTurnTypeaheadPushNow(ref, {
      runningToolNames: () => ['Bash'],
      interruptTurn: () => { throw new Error('must not interrupt'); },
      pushNotice: (line) => notices.push(line),
    });
    expect(decision).toEqual({ kind: 'deferred', blockingTools: ['Bash'] });
    expect(notices.join('\n')).not.toContain('최우선');
    expect(notices[0]).toContain('응답 뒤에');
    expect(ref.state.steerPriority).toBeUndefined();
  });

  test('priority: 끊지 않고 레지스트리 맨 앞으로 올려 다음 경계에 먼저 넣는다 · 표시는 ⚡', () => {
    const ref: TurnTypeaheadRef = { state: createTurnTypeaheadState() };
    enqueuePendingUserInput(SID, 'control memo');
    typeAndEnter(ref, 'urgent');
    let interrupted = 0;
    const decision = runTurnTypeaheadPushNow(ref, {
      runningToolNames: () => ['Bash'],
      interruptTurn: () => { interrupted += 1; },
      pushNotice: () => {},
    });
    expect(decision).toEqual({ kind: 'priority', blockingTools: ['Bash'] });
    expect(interrupted).toBe(0);
    expect(renderTurnTypeaheadQueueRow(ref.state, 120))
      .toBe('⚡ 최우선 · 다음 도구 경계에 넣음 1건 · "urgent" · Ctrl+↑ 되꺼내기 · 빈 Enter 지금 밀어 넣기');
    expect(drainPendingUserInput(SID)).toEqual(['urgent', 'control memo']);
    expect(renderTurnTypeaheadQueueRow(ref.state, 120)).toBe('✓ 넣음 1건 · 도는 턴에 이어서 반영');
  });
});
