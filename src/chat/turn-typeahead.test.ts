import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  applyTurnTypeaheadKey,
  renderTurnTypeaheadQueueRow,
  renderTurnTypeaheadEcho,
  createTurnTypeaheadState,
  dequeueTurnTypeaheadHandoff,
  drainTurnTypeaheadOnce,
  drainTurnTypeaheadQueue,
  drainedIntoTurn,
  restoreTurnTypeaheadSubmission,
} from './turn-typeahead.js';

const key = (name: string) => ({ name });

function type(text: string) {
  let state = createTurnTypeaheadState();
  for (const character of text) state = applyTurnTypeaheadKey(state, key(character)).state;
  return state;
}

describe('turn typeahead immediate submission decision', () => {
  test('marked slash command requests immediate execution without joining the FIFO', () => {
    const result = applyTurnTypeaheadKey(
      { buffer: '/observe child', queuedSubmissions: ['preserved sentence'] },
      key('enter'),
      text => text === '/observe child',
    );

    expect(result).toEqual({
      state: { buffer: '', queuedSubmissions: ['preserved sentence'] },
      consumed: true,
      changed: true,
      immediateSubmission: '/observe child',
      submissionDisposition: 'immediate',
    });
    expect(dequeueTurnTypeaheadHandoff(result.state).handoff)
      .toEqual({ kind: 'submit', text: 'preserved sentence' });
  });

  test('unmarked slash command and ordinary sentence retain FIFO submission behavior', () => {
    const unmarked = applyTurnTypeaheadKey(type('/unmarked command'), key('enter'), () => false);
    const sentence = applyTurnTypeaheadKey(type('ordinary sentence'), key('enter'), () => true);

    expect(unmarked).toEqual({
      state: { buffer: '', queuedSubmissions: ['/unmarked command'] },
      consumed: true,
      changed: true,
      submissionDisposition: 'fifo',
    });
    expect(sentence).toEqual({
      state: { buffer: '', queuedSubmissions: ['ordinary sentence'] },
      consumed: true,
      changed: true,
      submissionDisposition: 'fifo',
    });
  });

  test('lookup error falls back to FIFO and later keys remain processable', () => {
    const result = applyTurnTypeaheadKey(
      type('/marked command'),
      key('enter'),
      () => { throw new Error('registry unavailable'); },
    );
    const next = applyTurnTypeaheadKey(result.state, key('x'));

    expect(result).toEqual({
      state: { buffer: '', queuedSubmissions: ['/marked command'] },
      consumed: true,
      changed: true,
      submissionDisposition: 'fifo',
    });
    expect(next).toEqual({
      state: { buffer: 'x', queuedSubmissions: ['/marked command'] },
      consumed: true,
      changed: true,
    });
  });

  test('dispatch rejection rollback preserves the immediate command once in FIFO and later input remains processable', () => {
    const immediate = applyTurnTypeaheadKey(
      { buffer: '/observe child', queuedSubmissions: ['first sentence'] },
      key('enter'),
      text => text === '/observe child',
    );
    const rolledBack = restoreTurnTypeaheadSubmission(immediate.state, immediate.immediateSubmission!);
    const next = applyTurnTypeaheadKey(rolledBack, key('x'));

    expect(rolledBack).toEqual({
      buffer: '',
      queuedSubmissions: ['first sentence', '/observe child'],
    });
    expect(next).toEqual({
      state: { buffer: 'x', queuedSubmissions: ['first sentence', '/observe child'] },
      consumed: true,
      changed: true,
    });
    expect(dequeueTurnTypeaheadHandoff(rolledBack)).toEqual({
      handoff: { kind: 'submit', text: 'first sentence' },
      state: { buffer: '', queuedSubmissions: ['/observe child'] },
    });
  });

  test('blank enter remains unowned and does not invoke the lookup', () => {
    const lookup = () => { throw new Error('must not be called'); };
    expect(applyTurnTypeaheadKey(createTurnTypeaheadState(), key('enter'), lookup))
      .toEqual({ state: createTurnTypeaheadState(), consumed: false, changed: false });
  });
});


// ⛔⭐⭐ `B1`(2026-08-19 · 대표 지시) — 큐의 자리는 «컴포저»가 아니라 «스트리밍 프롬프트 영역»이다.
describe('renderTurnTypeaheadQueueRow — 큐 «행»', () => {
  const withQueue = (...items: string[]) => {
    let st = createTurnTypeaheadState();
    for (const item of items) {
      for (const ch of item) st = applyTurnTypeaheadKey(st, key(ch)).state;
      st = applyTurnTypeaheadKey(st, key('enter'), () => true).state;
    }
    return st;
  };

  test('큐가 비면 행이 «없다» — 빈 문자열이 아니라 null', () => {
    expect(renderTurnTypeaheadQueueRow(createTurnTypeaheadState(), 80)).toBeNull();
  });

  test('⭐ 대기 «내용»을 보여 준다 — 「1건」만으로는 무엇이 대기 중인지 모른다', () => {
    const row = renderTurnTypeaheadQueueRow(withQueue('카이사르 이후'), 80)!;
    expect(row).toContain('카이사르 이후');
    expect(row).toContain('대기 1건');
  });

  test('여럿이면 «가장 먼저 나갈 것»(FIFO 머리)을 보여 준다', () => {
    const row = renderTurnTypeaheadQueueRow(withQueue('첫째', '둘째'), 80)!;
    expect(row).toContain('대기 2건');
    expect(row).toContain('첫째');
    expect(row).not.toContain('둘째');
  });

  test('폭을 넘으면 «내용»을 줄이고 라벨은 지킨다', () => {
    const row = renderTurnTypeaheadQueueRow(withQueue('가'.repeat(300)), 40)!;
    expect(row).toContain('대기 1건');
    expect(row).toContain('…');
    expect(row.length).toBeLessThan(300);
  });
});

describe('drainedIntoTurn — 라이브 턴 배수 문장', () => {
  test('배수된 발화가 없으면 문장도 없고 상태는 그대로다', () => {
    const state = { buffer: 'draft', queuedSubmissions: ['대기'] };
    const result = drainedIntoTurn(state, []);
    expect(result.sentence).toBeNull();
    expect(result.state).toEqual(state);
    expect(result.state).toBe(state);
  });

  test('배수된 발화가 있으면 큐에서 FIFO로 떨어지고 무엇이 들어갔는지 문장을 낸다', () => {
    const state = { buffer: 'draft', queuedSubmissions: ['MIDLOOPTEST456', '둘째'] };
    const result = drainedIntoTurn(state, ['MIDLOOPTEST456']);
    expect(result.state).toEqual({ buffer: 'draft', queuedSubmissions: ['둘째'] });
    expect(result.sentence).toBe('⏳ 턴 안 1건 · "MIDLOOPTEST456" · 라이브 턴으로 전송');
    expect(renderTurnTypeaheadQueueRow(
      { buffer: '', queuedSubmissions: ['MIDLOOPTEST456'] },
      80,
    )).toBe('⏳ 대기 1건 · "MIDLOOPTEST456" · 턴 종료 시 전송 · Ctrl+↑ 되꺼내기');
  });

  test('여러 건이면 앞에서부터 떨어지고 들어간 내용을 모두 보여 준다', () => {
    const state = { buffer: '', queuedSubmissions: ['첫째', '둘째', '셋째'] };
    const result = drainedIntoTurn(state, ['첫째', '둘째']);
    expect(result.state).toEqual({ buffer: '', queuedSubmissions: ['셋째'] });
    expect(result.sentence).toBe('⏳ 턴 안 2건 · "첫째" · "둘째" · 라이브 턴으로 전송');
  });
});

describe('queued speech is delivered only once', () => {
  test('dashboard live drain removes its FIFO prefix before the turn-end handoff', () => {
    const dashboard = readFileSync(new URL('../dashboard/index.ts', import.meta.url), 'utf8');
    const callback = dashboard.slice(dashboard.indexOf('enqueuePendingUserInput(sid, queuedText, (drained) => {'));
    const body = callback.slice(0, callback.indexOf("debug.log('dashboard.turn-typeahead', 'drained-into-live-turn'"));
    expect(body).toContain('queuedSubmissions.slice(drained.length)');
    expect(body.indexOf('queuedSubmissions.slice(drained.length)')).toBeLessThan(body.indexOf('echoSubmittedUserText(text, { live: true })'));
    expect(dashboard).toContain('drainTurnTypeaheadOnce(turnTypeaheadRef.state, nextInitial, { interrupted })');
  });

  test('live-drained items cannot be handed off again at turn end; remaining items retain FIFO order', () => {
    const entered = ['Q2MARK 라고만 답해', 'Q3MARK 라고만 답해', 'Q4MARK 라고만 답해'];
    const state = { buffer: 'unsent draft', queuedSubmissions: entered };
    const live = drainedIntoTurn(state, entered.slice(0, 2));
    expect(live.state.queuedSubmissions).toEqual([entered[2]]);
    const next = dequeueTurnTypeaheadHandoff(live.state);
    expect(next.handoff).toEqual({ kind: 'submit', text: entered[2] });
    expect(dequeueTurnTypeaheadHandoff(next.state).handoff)
      .toEqual({ kind: 'prefill', text: 'unsent draft' });
  });
});

describe('drainTurnTypeaheadQueue / drainTurnTypeaheadOnce — 기존 계약 보존', () => {
  test('drainTurnTypeaheadQueue 는 큐를 통째로 비우고 버퍼는 건드리지 않는다', () => {
    const state = { buffer: 'draft', queuedSubmissions: ['첫째', '둘째'] };
    expect(drainTurnTypeaheadQueue(state)).toEqual({
      state: { buffer: 'draft', queuedSubmissions: [] },
      drained: ['첫째', '둘째'],
    });
    expect(drainTurnTypeaheadQueue(createTurnTypeaheadState())).toEqual({
      state: createTurnTypeaheadState(),
      drained: [],
    });
  });

  test('drainTurnTypeaheadOnce 는 한 걸음만 꺼내고 문장을 내지 않는다', () => {
    const queued = { buffer: '', queuedSubmissions: ['first', 'second'] };
    expect(drainTurnTypeaheadOnce(queued, null)).toEqual({
      state: { buffer: '', queuedSubmissions: ['second'] },
      nextInitial: 'first',
      injectEnter: true,
    });
    expect(drainTurnTypeaheadOnce(createTurnTypeaheadState(), 'carried')).toEqual({
      state: createTurnTypeaheadState(),
      nextInitial: 'carried',
      injectEnter: false,
    });
  });

  test('중단된 턴은 대기열과 버퍼를 입력으로 복원하고 큐를 비운다', () => {
    const state = { buffer: 'draft', queuedSubmissions: ['xyz', 'second'] };
    expect(drainTurnTypeaheadOnce(state, 'carried', { interrupted: true })).toEqual({
      state: createTurnTypeaheadState(),
      nextInitial: 'carried\nxyz\nsecond\ndraft',
      injectEnter: false,
    });
    expect(drainTurnTypeaheadOnce(state, undefined)).toEqual({
      state: { buffer: 'draft', queuedSubmissions: ['second'] },
      nextInitial: 'xyz',
      injectEnter: true,
    });
  });
});

describe('renderTurnTypeaheadEcho — 컴포저에서 큐 접미를 뗐다 (B1)', () => {
  test('⛔ 기본은 큐 접미를 «안» 붙인다 — 그 자리는 큐 행이다', () => {
    let st = createTurnTypeaheadState();
    for (const ch of 'abc') st = applyTurnTypeaheadKey(st, key(ch)).state;
    st = applyTurnTypeaheadKey(st, key('enter'), () => true).state;
    for (const ch of 'xy') st = applyTurnTypeaheadKey(st, key(ch)).state;
    expect(renderTurnTypeaheadEcho(st, 80)).toBe('xy');
  });

  test('옛 호출부 보존 — includeQueueSuffix 를 주면 종전 문면', () => {
    let st = createTurnTypeaheadState();
    for (const ch of 'abc') st = applyTurnTypeaheadKey(st, key(ch)).state;
    st = applyTurnTypeaheadKey(st, key('enter'), () => true).state;
    expect(renderTurnTypeaheadEcho(st, 80, { includeQueueSuffix: true })).toContain('1건 대기');
  });
});
