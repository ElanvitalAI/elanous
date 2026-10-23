import { describe, expect, test } from 'bun:test';
import {
  applyTurnTypeaheadKey,
  attachTurnTypeaheadPendingId,
  renderTurnTypeaheadQueueRow,
  renderTurnTypeaheadEcho,
  createTurnTypeaheadState,
  dequeueTurnTypeaheadHandoff,
  drainTurnTypeaheadOnce,
  drainTurnTypeaheadQueue,
  drainedIntoTurn,
  restoreTurnTypeaheadSubmission,
} from './turn-typeahead.js';
import { createPasteFold } from './paste-fold.js';
import { tuiSourceText } from '../../test/helpers/dashboard-source.js';

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
    expect(row).toContain('대기(응답 뒤) 1건');
  });

  test('여럿이면 «가장 먼저 나갈 것»(FIFO 머리)을 보여 준다', () => {
    const row = renderTurnTypeaheadQueueRow(withQueue('첫째', '둘째'), 80)!;
    expect(row).toContain('대기(응답 뒤) 2건');
    expect(row).toContain('첫째');
    expect(row).not.toContain('둘째');
  });

  test('폭을 넘으면 «내용»을 줄이고 라벨은 지킨다', () => {
    const row = renderTurnTypeaheadQueueRow(withQueue('가'.repeat(300)), 40)!;
    expect(row).toContain('대기(응답 뒤) 1건');
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
    expect(result.state).toEqual({ buffer: 'draft', queuedSubmissions: ['둘째'], injectedCount: 1 });
    expect(result.sentence).toBe('⏳ 턴 안 1건 · "MIDLOOPTEST456" · 라이브 턴으로 전송');
    expect(renderTurnTypeaheadQueueRow(
      { buffer: '', queuedSubmissions: ['MIDLOOPTEST456'] },
      80,
    )).toBe('⏳ 대기(응답 뒤) 1건 · "MIDLOOPTEST456" · Ctrl+↑ 되꺼내기 · 빈 Enter 지금 밀어 넣기');
  });

  test('여러 건이면 앞에서부터 떨어지고 들어간 내용을 모두 보여 준다', () => {
    const state = { buffer: '', queuedSubmissions: ['첫째', '둘째', '셋째'] };
    const result = drainedIntoTurn(state, ['첫째', '둘째']);
    expect(result.state).toEqual({ buffer: '', queuedSubmissions: ['셋째'], injectedCount: 2 });
    expect(result.sentence).toBe('⏳ 턴 안 2건 · "첫째" · "둘째" · 라이브 턴으로 전송');
  });
});

describe('queued speech is delivered only once', () => {
  test('dashboard live drain pairs registry ids and releases handed-off items', () => {
    const dashboard = tuiSourceText();
    expect(dashboard).toContain('steerLastTurnTypeaheadSubmission(turnTypeaheadRef, sid,');
    expect(dashboard).toContain("if (r.releasedPendingIds) releaseTurnTypeaheadPending(r.releasedPendingIds, 'recalled');");
    // 턴 종료 핸드오프(드레인 → 해제 → Enter)는 다리 모듈 한 함수다 — 순서·Enter 는 turn-steer-bridge.test.ts 가 행동으로 문다.
    expect(dashboard).toContain('handoffTurnTypeaheadAtTurnEnd(turnTypeaheadRef, nextInitial, { interrupted }, () => {');
    const turnEnd = dashboard.slice(dashboard.indexOf('handoffTurnTypeaheadAtTurnEnd(turnTypeaheadRef, nextInitial, { interrupted }, () => {'));
    // ⛔ 그 콜백이 «진짜» Enter 를 주입해야 한다 — 빈 콜백이면 승격 발화가 composer 에 갇힌다.
    expect(turnEnd.slice(0, 200)).toContain("injectKey({ name: 'enter', ctrl: false, shift: false });");
    expect(dashboard).not.toContain('drainTurnTypeaheadOnce(turnTypeaheadRef.state');
    expect(dashboard).not.toContain('queuedSubmissions.slice(drained.length)');
    // «지금 밀어 넣기»로 끊은 턴은 복원이 아니라 제출로 간다.
    expect(dashboard).toContain('const interrupted = consumeTurnEndInterrupted(lastTurnFinalStatus, steerInterruptRef);');
    expect(dashboard).toContain('steerInterruptRef.pending = true;');
    expect(dashboard).toContain('runTurnTypeaheadPushNow(turnTypeaheadRef, {');
    expect(dashboard).toContain('abortTurnOnly(abortCtrl);');
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
      releasedPendingIds: [],
    });
    expect(drainTurnTypeaheadOnce(createTurnTypeaheadState(), 'carried')).toEqual({
      state: createTurnTypeaheadState(),
      nextInitial: 'carried',
      injectEnter: false,
      releasedPendingIds: [],
    });
  });

  test('중단된 턴은 대기열과 버퍼를 입력으로 복원하고 큐를 비운다', () => {
    const state = { buffer: 'draft', queuedSubmissions: ['xyz', 'second'] };
    expect(drainTurnTypeaheadOnce(state, 'carried', { interrupted: true })).toEqual({
      state: createTurnTypeaheadState(),
      nextInitial: 'carried\nxyz\nsecond\ndraft',
      injectEnter: false,
      releasedPendingIds: [],
    });
    expect(drainTurnTypeaheadOnce(state, undefined)).toEqual({
      state: { buffer: 'draft', queuedSubmissions: ['second'] },
      nextInitial: 'xyz',
      injectEnter: true,
      releasedPendingIds: [],
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

describe('queuedPendingIds 칸 모양', () => {
  test('짝이 다 빠지면 칸 자체가 없다(undefined 키도 없다)', () => {
    let state = attachTurnTypeaheadPendingId({ buffer: '', queuedSubmissions: ['a'] }, 0, 'pending-x');
    expect(state.queuedPendingIds).toEqual(['pending-x']);
    state = dequeueTurnTypeaheadHandoff(state).state;
    expect('queuedPendingIds' in state).toBe(false);
    const drained = drainTurnTypeaheadQueue(attachTurnTypeaheadPendingId({ buffer: '', queuedSubmissions: ['b'] }, 0, 'pending-y'));
    expect('queuedPendingIds' in drained.state).toBe(false);
  });
});

describe('TUI-PASTE-WHILE-STREAMING — 턴 중 붙여넣기는 버리지 않는다', () => {
  const paste = (text: string) => ({ name: 'paste', paste: text });
  const enter = { name: 'enter' };
  const long = Array.from({ length: 50 }, (_, i) => `busy-line-${i}`).join('\n');

  test('반례: busy 상태에서 짧은 붙여넣기 → 버퍼에 그대로 보존(소유)', () => {
    const r = applyTurnTypeaheadKey({ ...createTurnTypeaheadState(), buffer: '앞 ' }, paste('busy-paste-short'));
    expect(r.consumed).toBe(true);
    expect(r.state.buffer).toBe('앞 busy-paste-short');
    expect(r.pasted).toEqual({ folded: false, lines: 1, chars: 16 });
  });

  test('긴 붙여넣기 → 버퍼는 자리표시 토큰 · Enter 하면 원문 전부가 FIFO 로', () => {
    const a = applyTurnTypeaheadKey(createTurnTypeaheadState(), paste(`${long}\r\n`));
    expect(a.state.buffer).toBe('[붙여넣음 #1 · 50줄 · ' + long.length + '자]');
    expect(a.pasted?.folded).toBe(true);
    const b = applyTurnTypeaheadKey({ ...a.state, buffer: `${a.state.buffer} 요약해 줘` }, enter);
    expect(b.submissionDisposition).toBe('fifo');
    expect(b.state.queuedSubmissions).toEqual([`${long}\n 요약해 줘`]);
    expect(b.state.buffer).toBe('');
    expect(b.state.pastes).toBeUndefined();
  });

  test('r1 반례: 끝 줄바꿈은 보존한다 — 짧은 글은 버퍼에 그대로 · 긴 글은 제출 원문에', () => {
    expect(applyTurnTypeaheadKey(createTurnTypeaheadState(), paste('hello\r\n')).state.buffer).toBe('hello\n');
    const a = applyTurnTypeaheadKey(createTurnTypeaheadState(), paste(`${long}\n`));
    expect(a.state.buffer).toBe('[붙여넣음 #1 · 50줄 · ' + long.length + '자]');
    expect(applyTurnTypeaheadKey(a.state, enter).state.queuedSubmissions).toEqual([`${long}\n`]);
  });

  test('토큰 끝에서 Backspace 는 토큰 통째로 지우고 원문도 놓는다', () => {
    const a = applyTurnTypeaheadKey(createTurnTypeaheadState(), paste(long));
    const b = applyTurnTypeaheadKey(a.state, { name: 'backspace' });
    expect(b.state.buffer).toBe('');
    expect(b.state.pastes).toBeUndefined();
  });

  test('제출 안 한 붙여넣기는 턴 끝 prefill·중단 복원 때 토큰째 ⊕ 원문 짝을 같이 넘긴다', () => {
    const a = applyTurnTypeaheadKey(createTurnTypeaheadState(), paste(long));
    const token = a.state.buffer;
    expect(dequeueTurnTypeaheadHandoff(a.state).handoff).toEqual({ kind: 'prefill', text: token, pastes: [[token, long]] });
    const once = drainTurnTypeaheadOnce(a.state, undefined);
    expect(once.nextInitial).toBe(token);
    expect(once.initialPastes).toEqual([[token, long]]);
    const queued = { ...a.state, queuedSubmissions: ['먼저'] };
    const restored = drainTurnTypeaheadOnce(queued, undefined, { interrupted: true });
    expect(restored.nextInitial).toBe(`먼저\n${token}`);
    expect(restored.initialPastes).toEqual([[token, long]]);
  });

  test('넘겨받은 입력창의 pasteFold 는 짝을 받아 제출 때 원문으로 편다 · 새 붙여넣기 번호는 겹치지 않는다', () => {
    const a = applyTurnTypeaheadKey(createTurnTypeaheadState(), paste(long));
    const fold = createPasteFold(() => {});
    fold.adopt([[a.state.buffer, long]]);
    const next = fold.fold(`${long}\nmore`);
    expect(next).not.toBe(a.state.buffer);
    expect(next.startsWith('[붙여넣음 #2 ')).toBe(true);
    expect(fold.expand(`${a.state.buffer} 끝`)).toBe(`${long} 끝`);
  });
});
