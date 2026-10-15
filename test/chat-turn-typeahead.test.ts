// ── C-d-3' 턴 중 타이핑 보존 — 순수 판정 테스트 (2026-07-13) ──────────────────

import { describe, expect, test, it } from 'bun:test';
import {
  createTurnTypeaheadState,
  applyTurnTypeaheadKey,
  dequeueTurnTypeaheadHandoff,
  drainTurnTypeaheadOnce,
  resolveTurnTypeaheadHandoff,
  renderTurnTypeaheadEcho,
  isTypeaheadPrintable,
} from '../src/chat/turn-typeahead.js';
import { simTypeaheadState } from '../src/ux-sim/turn-states.js';

const key = (name: string, mods: Record<string, unknown> = {}) => ({ name, ...mods });

function type(text: string, state = createTurnTypeaheadState()) {
  let st = state;
  for (const ch of text) st = applyTurnTypeaheadKey(st, key(ch)).state;
  return st;
}

function submit(text: string, state = createTurnTypeaheadState()) {
  return applyTurnTypeaheadKey(type(text, state), key('enter')).state;
}

describe('applyTurnTypeaheadKey', () => {
  test('printable 누적 — 한글 음절/자모·space 포함, j/k/f 도 문자', () => {
    let st = type('hij');
    st = applyTurnTypeaheadKey(st, key('space')).state;
    st = applyTurnTypeaheadKey(st, key('안')).state;
    st = applyTurnTypeaheadKey(st, key('ㅣ')).state;
    expect(st.buffer).toBe('hij 안ㅣ');
  });

  test('명명 키(up/tab/escape/pageup)·ctrl/alt·mouse·release 는 미소유', () => {
    const st = createTurnTypeaheadState();
    for (const k of [key('up'), key('pageup'), key('tab'), key('escape'),
      key('l', { ctrl: true }), key('m', { alt: true }),
      key('a', { mouse: { type: 'click' } }), key('a', { kind: 'release' })]) {
      const r = applyTurnTypeaheadKey(st, k as never);
      expect(r.consumed).toBe(false);
    }
  });

  test('backspace — 마지막 코드포인트 제거 · 빈 버퍼면 미소유', () => {
    let st = type('ab');
    const r1 = applyTurnTypeaheadKey(st, key('backspace'));
    expect(r1.consumed).toBe(true);
    expect(r1.state.buffer).toBe('a');
    st = applyTurnTypeaheadKey(r1.state, key('backspace')).state;
    expect(st.buffer).toBe('');
    expect(applyTurnTypeaheadKey(st, key('backspace')).consumed).toBe(false);
  });

  test('enter — 버퍼 있으면 FIFO에 넣고 빈 입력은 미소유', () => {
    expect(applyTurnTypeaheadKey(createTurnTypeaheadState(), key('enter')).consumed).toBe(false);
    const st = submit('go');
    expect(st).toEqual({ buffer: '', queuedSubmissions: ['go'] });
  });

  test('ctrl+up: 마지막 대기 항목을 현재 버퍼 뒤로 되꺼내고 FIFO 순서를 보존한다', () => {
    let state = createTurnTypeaheadState();
    for (const text of ['first', 'second', 'third']) state = submit(text, state);

    const recalled = applyTurnTypeaheadKey(state, key('up', { ctrl: true }));
    expect(Object.keys(recalled).sort()).toEqual(['changed', 'consumed', 'state']);
    expect(recalled.consumed).toBe(true);
    expect(recalled.changed).toBe(true);
    expect(recalled.state).toEqual({ buffer: 'third', queuedSubmissions: ['first', 'second'] });

    const requeued = applyTurnTypeaheadKey(recalled.state, key('enter'));
    expect(requeued.state.queuedSubmissions).toEqual(['first', 'second', 'third']);
  });

  test('ctrl+up: 기존 버퍼는 잃지 않고 마지막 대기 항목 뒤에 이어 붙인다', () => {
    const state = type('draft-', submit('queued'));
    expect(applyTurnTypeaheadKey(state, key('up', { ctrl: true })).state)
      .toEqual({ buffer: 'draft-queued', queuedSubmissions: [] });
  });

  test('ctrl+up: 빈 큐에서는 미소유이고 상태를 그대로 돌려준다', () => {
    const state = type('draft');
    const result = applyTurnTypeaheadKey(state, key('up', { ctrl: true }));
    expect(result).toEqual({ state, consumed: false, changed: false });
  });

  // ⛔ 정확한 조합만 소유해야 한다 — 수식자가 섞이면 다른 층에 양보한다.
  test('ctrl+up: shift·meta·alt 가 섞이면 소유하지 않는다', () => {
    const state = submit('queued');
    for (const mods of [{ ctrl: true, shift: true }, { ctrl: true, meta: true }, { ctrl: true, alt: true }]) {
      const r = applyTurnTypeaheadKey(state, key('up', mods));
      expect(r.consumed).toBe(false);
      expect(r.state).toEqual(state);
    }
  });

  test('depth-n: 반복 Enter는 각 문장을 유실 없이 FIFO에 쌓고 반환 계약을 유지한다', () => {
    let st = createTurnTypeaheadState();
    st = submit('first', st);
    st = submit('second', st);
    const result = applyTurnTypeaheadKey(type('third', st), key('enter'));

    expect(result.state.queuedSubmissions).toEqual(['first', 'second', 'third']);
    expect(result.state.buffer).toBe('');
    expect(result.consumed).toBe(true);
    expect(result.changed).toBe(true);
    expect(Object.keys(result).sort()).toEqual(['changed', 'consumed', 'state', 'submissionDisposition']);
    expect(result.submissionDisposition).toBe('fifo');
  });

  test('enter 뒤 새 문장은 이전 큐 항목과 분리된다', () => {
    const st = type('next', submit('go'));
    expect(st).toEqual({ buffer: 'next', queuedSubmissions: ['go'] });
  });
});

describe('dequeueTurnTypeaheadHandoff', () => {
  test('order: FIFO가 한 턴마다 입력된 순서대로 하나씩 submit한다', () => {
    let st = submit('first');
    st = submit('second', st);
    st = submit('third', st);
    const sent: string[] = [];

    for (let handoff = dequeueTurnTypeaheadHandoff(st); handoff.handoff.kind !== 'none'; handoff = dequeueTurnTypeaheadHandoff(handoff.state)) {
      expect(handoff.handoff.kind).toBe('submit');
      if (handoff.handoff.kind === 'submit') sent.push(handoff.handoff.text);
      st = handoff.state;
    }

    expect(sent).toEqual(['first', 'second', 'third']);
    expect(st).toEqual(createTurnTypeaheadState());
  });

  test('depth-one-same: 한 번 Enter한 입력은 종전과 같이 submit한다', () => {
    const st = submit('run it');
    expect(resolveTurnTypeaheadHandoff(st)).toEqual({ kind: 'submit', text: 'run it' });
  });

  test('큐가 비면 미제출 buffer는 prefill하고 빈 상태는 none이다', () => {
    expect(dequeueTurnTypeaheadHandoff(createTurnTypeaheadState()).handoff).toEqual({ kind: 'none' });
    expect(dequeueTurnTypeaheadHandoff(type('draft')).handoff).toEqual({ kind: 'prefill', text: 'draft' });
  });
});

describe('renderTurnTypeaheadEcho', () => {
  test('기본은 큐 접미를 붙이지 않고 폭 초과 시 끝부분을 우선한다', () => {
    const queued = simTypeaheadState({ phase: 'streaming', queued: ['first', 'hello'] });
    expect(renderTurnTypeaheadEcho(queued, 80)).toBe('');

    const long = simTypeaheadState({ phase: 'streaming', draft: '0123456789abcdef' });
    const echo = renderTurnTypeaheadEcho(long, 12);
    expect(echo.endsWith('abcdef')).toBe(true);
    expect(echo.length).toBeLessThanOrEqual(12);
  });

  test('includeQueueSuffix는 옛 호출부를 보존하고 폭 초과 시 끝부분을 우선한다', () => {
    const queued = simTypeaheadState({ phase: 'streaming', queued: ['first', 'hello'] });
    expect(renderTurnTypeaheadEcho(queued, 80, { includeQueueSuffix: true }))
      .toBe('  ⏎ 2건 대기 · 턴 종료 시 전송');

    const long = simTypeaheadState({
      phase: 'streaming',
      queued: ['first', 'hello'],
      draft: '0123456789abcdef',
    });
    const echo = renderTurnTypeaheadEcho(long, 30, { includeQueueSuffix: true });
    expect(echo.startsWith('89abcdef')).toBe(true);
    expect(echo.endsWith('턴 종료 시 전송')).toBe(true);
    expect(echo.length).toBeLessThanOrEqual(30);
  });
});

describe('isTypeaheadPrintable', () => {
  test('단일 코드포인트/space true · 명명 키/수정키 false', () => {
    expect(isTypeaheadPrintable(key('a') as never)).toBe(true);
    expect(isTypeaheadPrintable(key('가') as never)).toBe(true);
    expect(isTypeaheadPrintable(key('space') as never)).toBe(true);
    expect(isTypeaheadPrintable(key('enter') as never)).toBe(false);
    expect(isTypeaheadPrintable(key('a', { ctrl: true }) as never)).toBe(false);
  });
});

// ⛔⭐⭐⭐ 무인 리뷰 must-fix — 종전 테스트는 `index.ts` 의 드레인 순서를 **베껴 모사**했다.
//    베낀 테스트는 배선 회귀를 못 잡는다(Goodhart). ⇒ 그 순서를 `drainTurnTypeaheadOnce` 로
//    옮겼고 `index.ts` 가 그 함수를 부른다. 이제 이 테스트는 **실제로 도는 코드**를 탄다.
describe('drainTurnTypeaheadOnce — index.ts inner-loop 가 반복마다 부르는 한 걸음', () => {
  it('한 걸음에 한 건씩 · 친 순서 그대로 · submit 마다 enter 를 주입한다', () => {
    let state = createTurnTypeaheadState();
    for (const text of ['first', 'second', 'third']) state = submit(text, state);

    const submitted: string[] = [];
    let enters = 0;
    for (let i = 0; i < 10; i++) {
      const before = state;
      const drained = drainTurnTypeaheadOnce(state, null);
      state = drained.state;
      if (drained.nextInitial === undefined) {
        expect(drainTurnTypeaheadOnce(before, null).injectEnter).toBe(false);
        break;
      }
      submitted.push(drained.nextInitial);
      if (drained.injectEnter) enters++;
    }

    expect(submitted).toEqual(['first', 'second', 'third']);
    expect(enters).toBe(3);
  });

  it('앞선 nextInitial 이 있으면 이어 붙인다 (index.ts 의 누적 규칙)', () => {
    const state = submit('tail');
    expect(drainTurnTypeaheadOnce(state, 'head-').nextInitial).toBe('head-tail');
  });

  it('빈 큐면 carried 를 그대로 돌려주고 enter 를 주입하지 않는다', () => {
    const drained = drainTurnTypeaheadOnce(createTurnTypeaheadState(), 'carried');
    expect(drained.nextInitial).toBe('carried');
    expect(drained.injectEnter).toBe(false);
  });

  it('중단된 턴은 대기열 전체와 미제출 버퍼를 입력으로 복원하고 전송하지 않는다', () => {
    const state = { buffer: 'draft', queuedSubmissions: ['xyz', 'second'] };
    const drained = drainTurnTypeaheadOnce(state, undefined, { interrupted: true });

    expect(drained).toEqual({
      state: createTurnTypeaheadState(),
      nextInitial: 'xyz\nsecond\ndraft',
      injectEnter: false,
      releasedPendingIds: [],
    });
    expect(drainTurnTypeaheadOnce(state, 'carried', { interrupted: true }).nextInitial)
      .toBe('carried\nxyz\nsecond\ndraft');
    expect(drainTurnTypeaheadOnce({ buffer: 'draft', queuedSubmissions: [] }, undefined, { interrupted: true }))
      .toEqual({
        state: createTurnTypeaheadState(),
        nextInitial: 'draft',
        injectEnter: false,
        releasedPendingIds: [],
      });
  });
});
