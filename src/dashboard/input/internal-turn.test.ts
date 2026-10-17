import { describe, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { textInput, type InputResult, type TextInputHost } from '../../chat/index.js';
import { debug } from '../../debug/log.js';
import type { Key } from '../../tui.js';
import {
  consumeInternalTurnYield,
  createInternalTurnGate,
  formatInternalTurnBanner,
  isInternalTurnEnabledByEnv,
  resolveInternalTurnSubmitIntent,
  type InternalTurnGateDeps,
} from './internal-turn.js';

type LogRow = { category: string; event: string; data: Record<string, unknown> };

function harness(over: Partial<InternalTurnGateDeps> = {}) {
  const logs: LogRow[] = [];
  const state = { running: false, buffer: '' as string | undefined, typeahead: 0, pendingKeys: 0, lastKey: 0, now: 100_000 };
  const gate = createInternalTurnGate({
    isEnabled: () => true,
    isTurnRunning: () => state.running,
    getBufferText: () => state.buffer,
    getTypeaheadCount: () => state.typeahead,
    pendingKeyCount: () => state.pendingKeys,
    lastHumanKeyAt: () => state.lastKey,
    now: () => state.now,
    humanQuietMs: 10_000,
    log: (category, event, data) => { logs.push({ category, event, data }); },
    ...over,
  });
  // 마운트된 입력칸 흉내 — 버퍼가 비었을 때만 물러난다(실물 textInput 계약과 같다).
  let yields = 0;
  const mount = () => gate.port.attach(() => {
    if ((state.buffer ?? '').length > 0) return false;
    yields += 1;
    return true;
  });
  return { gate, state, logs, mount, yields: () => yields };
}

describe('startTurnIfIdle — 내부 턴 문 판정', () => {
  test('유휴 → opened ⊕ 물러남 1회 ⊕ 요청을 정확히 한 번 꺼낸다 ⊕ 입력칸 버퍼 불변', () => {
    const h = harness();
    h.mount();
    const r = h.gate.startTurnIfIdle('  남은 우편 확인  ', { origin: 'msg-wake', reason: '안 읽은 우편 2' });
    expect(r).toEqual({ opened: true, turnId: 'auto-1' });
    expect(h.yields()).toBe(1);
    expect(h.state.buffer).toBe('');
    expect(h.gate.takePending()).toEqual({ turnId: 'auto-1', input: '남은 우편 확인', origin: 'msg-wake', reason: '안 읽은 우편 2' });
    expect(h.gate.takePending()).toBeNull();
    expect(h.gate.isInternalTurnActive()).toBe(true);
    expect(h.gate.lastTurnId()).toBe('auto-1');
    expect(h.logs).toEqual([{ category: 'tui.autoturn', event: 'opened', data: { origin: 'msg-wake', reason: '안 읽은 우편 2', turnId: 'auto-1' } }]);
    h.gate.noteTurnSettled();
    expect(h.gate.isInternalTurnActive()).toBe(false);
  });

  test('턴 중 → NotIdle(turn-running) · 물러남 0', () => {
    const h = harness();
    h.mount();
    h.state.running = true;
    expect(h.gate.startTurnIfIdle('x', { origin: 'autowake' })).toEqual({ opened: false, reason: 'NotIdle', detail: 'turn-running' });
    expect(h.yields()).toBe(0);
    expect(h.logs[0]).toEqual({ category: 'tui.autoturn', event: 'rejected', data: { origin: 'autowake', reason: 'NotIdle', turnId: null, detail: 'turn-running' } });
  });

  test('입력칸이 안 떠 있으면(다른 창·모달) NotIdle · 앞 내부 턴이 아직 안 꺼내졌으면 NotIdle', () => {
    const h = harness();
    expect(h.gate.startTurnIfIdle('x', { origin: 'autowake' })).toMatchObject({ reason: 'NotIdle', detail: 'input-not-mounted' });
    h.mount();
    expect(h.gate.startTurnIfIdle('a', { origin: 'autowake' }).opened).toBe(true);
    expect(h.gate.startTurnIfIdle('b', { origin: 'scheduled' })).toMatchObject({ reason: 'NotIdle', detail: 'internal-turn-pending' });
    const bg = harness({ isInputForeground: () => false });
    bg.mount();
    expect(bg.gate.startTurnIfIdle('x', { origin: 'autowake' })).toMatchObject({ reason: 'NotIdle', detail: 'input-not-foreground' });
  });

  test('입력칸에 글자 · 안 읽힌 키 · 턴 중 쳐 둔 글 · 조용창 안 → HumanTyping(각 사유)', () => {
    const cases: Array<[string, (s: ReturnType<typeof harness>['state']) => void]> = [
      ['buffer', (s) => { s.buffer = '사람 초안'; }],
      ['unread-keys', (s) => { s.pendingKeys = 1; }],
      ['typeahead', (s) => { s.typeahead = 1; }],
      ['quiet-window', (s) => { s.lastKey = s.now - 3_000; }],
    ];
    for (const [detail, arrange] of cases) {
      const h = harness();
      h.mount();
      arrange(h.state);
      const before = h.state.buffer;
      expect(h.gate.startTurnIfIdle('x', { origin: 'autowake' })).toEqual({ opened: false, reason: 'HumanTyping', detail });
      expect(h.yields()).toBe(0);
      expect(h.state.buffer).toBe(before); // 입력칸 무접촉
      expect(h.gate.takePending()).toBeNull();
    }
    // 조용창이 지나면 연다.
    const h = harness();
    h.mount();
    h.state.lastKey = h.state.now - 10_001;
    expect(h.gate.startTurnIfIdle('x', { origin: 'autowake' }).opened).toBe(true);
  });

  test('expectedPrevTurnId 가 다르면 Superseded — 그 사이 사람이 턴을 열었다', () => {
    const h = harness();
    h.mount();
    const first = h.gate.startTurnIfIdle('a', { origin: 'goal-continue' });
    expect(first.opened).toBe(true);
    h.gate.takePending();
    h.gate.noteTurnSettled();
    const prev = h.gate.lastTurnId()!;
    h.gate.noteHumanTurn(); // 사람이 끼어들어 턴을 열었다
    expect(h.gate.startTurnIfIdle('b', { origin: 'goal-continue', expectedPrevTurnId: prev }))
      .toMatchObject({ opened: false, reason: 'Superseded' });
    // 지금의 마지막 턴을 기대하면 연다.
    expect(h.gate.startTurnIfIdle('b', { origin: 'goal-continue', expectedPrevTurnId: h.gate.lastTurnId()! }).opened).toBe(true);
  });

  test('Disabled · Cap — 스위치와 호출자 상한 판정을 존중한다', () => {
    const off = harness({ isEnabled: () => false });
    off.mount();
    expect(off.gate.startTurnIfIdle('x', { origin: 'autowake' })).toEqual({ opened: false, reason: 'Disabled' });
    const h = harness();
    h.mount();
    expect(h.gate.startTurnIfIdle('x', { origin: 'autowake', capReached: true })).toEqual({ opened: false, reason: 'Cap' });
    expect(h.yields()).toBe(0);
    expect(isInternalTurnEnabledByEnv({})).toBe(true);
    expect(isInternalTurnEnabledByEnv({ ELANOUS_TUI_AUTOTURN: '0' })).toBe(false);
    expect(isInternalTurnEnabledByEnv({ ELANOUS_TUI_AUTOTURN: 'off' })).toBe(false);
  });

  test('늦은 물러남 거절(판정 뒤 사람이 글자를 넣음) → 연 턴을 거두고 HumanTyping(late) 로그', () => {
    const h = harness();
    h.mount();
    expect(h.gate.startTurnIfIdle('x', { origin: 'autowake' }).opened).toBe(true);
    h.gate.port.declined?.('buffer');
    expect(h.gate.takePending()).toBeNull();
    expect(h.logs.at(-1)).toEqual({ category: 'tui.autoturn', event: 'rejected', data: { origin: 'autowake', reason: 'HumanTyping', turnId: 'auto-1', detail: 'late:buffer' } });
    // 실행 안 된 턴은 Superseded 기준이 되지 않는다 — 직전 id 로 되돌린다.
    expect(h.gate.lastTurnId()).toBeNull();
  });

  test('열고 나서 사람이 먼저 Enter·Esc 로 입력칸을 끝내면(물러나지 않고 내려감) 연 턴을 거두고 문이 다시 열린다', () => {
    const h = harness();
    h.mount();
    const human = h.gate.noteHumanTurn();
    expect(h.gate.startTurnIfIdle('a', { origin: 'autowake', expectedPrevTurnId: human }).opened).toBe(true);
    h.gate.port.detach({ yielded: false });
    expect(h.gate.takePending()).toBeNull();
    expect(h.gate.lastTurnId()).toBe(human);
    expect(h.logs.at(-1)).toMatchObject({ event: 'rejected', data: { reason: 'HumanTyping', turnId: 'auto-2', detail: 'late:input-closed' } });
    h.mount();
    // 걸린 요청이 없으니 NotIdle(internal-turn-pending) 로 막히지 않고, 직전 사람 턴 기대도 그대로 맞는다.
    expect(h.gate.startTurnIfIdle('b', { origin: 'autowake', expectedPrevTurnId: human }).opened).toBe(true);
  });

  test('반증 — 문이 «사람이 먼저»를 안 지키면(버퍼 확인을 빼면) 이 시험이 문다', () => {
    // 물러남 함수가 버퍼를 안 보는 입력칸이어도 문 자체가 HumanTyping 으로 막아야 한다.
    const h = harness();
    h.gate.port.attach(() => true);
    h.state.buffer = '초안';
    expect(h.gate.startTurnIfIdle('x', { origin: 'autowake' })).toMatchObject({ opened: false, reason: 'HumanTyping' });
  });
});

describe('입력 정책 — 슬래시 해석 없음 · 화면 한 줄', () => {
  test('내부 턴 제출 의도는 슬래시 글이어도 늘 plain · 출처는 scheduled(internal-turn:<origin>:<id>)', () => {
    const intent = resolveInternalTurnSubmitIntent({ turnId: 'auto-7', input: '/quit', origin: 'scheduled' }, 'sess-1');
    expect(intent).toEqual({
      kind: 'submit-turn',
      source: { kind: 'scheduled', jobId: 'internal-turn:scheduled:auto-7' },
      text: '/quit',
      route: 'plain',
      sessionId: 'sess-1',
    });
  });

  test('화면 줄 «↻ 자동 재개(<origin>): <이유>» — 이유는 한 줄로 접는다', () => {
    expect(formatInternalTurnBanner({ origin: 'msg-wake', reason: '안 읽은\n우편  2' })).toBe('↻ 자동 재개(msg-wake): 안 읽은 우편 2');
    expect(formatInternalTurnBanner({ origin: 'autowake' })).toBe('↻ 자동 재개(autowake)');
  });
});

describe('실물 textInput ⊕ 문 — 입력칸을 거치지 않고 물러난다', () => {
  const enter: Key = { name: 'enter', ctrl: false, shift: false };
  const blank: Key = { name: '', ctrl: false, shift: false };

  async function withQuietStdout<T>(fn: () => Promise<T>): Promise<T> {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    const originalWrite = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try { return await fn(); } finally { process.stdout.write = originalWrite; log.mockRestore(); }
  }

  test('빈 입력칸 → opened ⊕ textInput 이 yieldedToInternalTurn 로 돌아온다 ⊕ submit·버퍼 무접촉 ⊕ 턴 실행 1회', async () => {
    const control: NonNullable<TextInputHost['control']> = { repaint: () => {} };
    let submitCalls = 0;
    const gate = createInternalTurnGate({
      isEnabled: () => true,
      isTurnRunning: () => false,
      getBufferText: () => control.getBufferText?.(),
      getTypeaheadCount: () => 0,
      pendingKeyCount: () => 0,
      lastHumanKeyAt: () => 0,
      log: () => {},
    });
    let opened: unknown;
    let bufferAtOpen: string | undefined;
    let reads = 0;
    const result: InputResult = await withQuietStdout(() => textInput({
      row: 3, col: 1, width: 80, initialText: '',
      host: { control },
      internalTurnYield: gate.port,
      readKey: async () => {
        if (reads++ === 0) {
          const realSubmit = control.submit;
          control.submit = (...a) => { submitCalls += 1; return realSubmit?.(...a); };
          opened = gate.startTurnIfIdle('다음 행 진행', { origin: 'autowake', reason: '큐 3' });
          bufferAtOpen = control.getBufferText?.();
          return blank; // 실물에선 cancelPendingReadKey 가 걸린 readKey 를 빈 키로 깨운다
        }
        return enter;
      },
    }));
    expect(opened).toEqual({ opened: true, turnId: 'auto-1' });
    expect(bufferAtOpen).toBe('');
    expect(result).toEqual({ text: '', submitted: false, yieldedToInternalTurn: true });
    expect(submitCalls).toBe(0);
    // 대시보드가 부르는 «바로 그» 분기 함수 — 같은 턴 실행 경로에 넣을 제출 결과가 정확히 한 번 나온다.
    const consumed = consumeInternalTurnYield(gate, result);
    expect(consumed).toEqual({
      kind: 'internal',
      request: { turnId: 'auto-1', input: '다음 행 진행', origin: 'autowake', reason: '큐 3' },
      input: { text: '다음 행 진행', submitted: true },
    });
    expect(consumeInternalTurnYield(gate, result)).toEqual({ kind: 'reenter' });
    expect(gate.takePending()).toBeNull();
    // 내려간 입력칸에는 더 이상 문이 닿지 않는다.
    expect(gate.startTurnIfIdle('또', { origin: 'autowake' })).toMatchObject({ opened: false, reason: 'NotIdle', detail: 'input-not-mounted' });
  });

  test('사람 초안이 있으면 문은 HumanTyping · textInput 은 그 초안을 그대로 제출한다(내부 턴 끼어들기 0)', async () => {
    const control: NonNullable<TextInputHost['control']> = { repaint: () => {} };
    const gate = createInternalTurnGate({
      isEnabled: () => true,
      isTurnRunning: () => false,
      getBufferText: () => control.getBufferText?.(),
      getTypeaheadCount: () => 0,
      pendingKeyCount: () => 0,
      lastHumanKeyAt: () => 0,
      log: () => {},
    });
    let rejected: unknown;
    let reads = 0;
    const result = await withQuietStdout(() => textInput({
      row: 3, col: 1, width: 80, initialText: '사람 초안',
      host: { control },
      internalTurnYield: gate.port,
      readKey: async () => {
        if (reads++ === 0) rejected = gate.startTurnIfIdle('자동', { origin: 'autowake' });
        return enter;
      },
    }));
    expect(rejected).toEqual({ opened: false, reason: 'HumanTyping', detail: 'buffer' });
    expect(result).toEqual({ text: '사람 초안', submitted: true });
    expect(consumeInternalTurnYield(gate, result)).toEqual({ kind: 'human', input: result });
    expect(gate.takePending()).toBeNull();
  });

  test('열린 뒤 사람이 Enter 를 먼저 치면 사람 입력이 나가고 연 턴은 거둬진다(실물 textInput)', async () => {
    const control: NonNullable<TextInputHost['control']> = { repaint: () => {} };
    const gate = createInternalTurnGate({
      isEnabled: () => true,
      isTurnRunning: () => false,
      getBufferText: () => control.getBufferText?.(),
      getTypeaheadCount: () => 0,
      pendingKeyCount: () => 0,
      lastHumanKeyAt: () => 0,
      log: () => {},
    });
    let reads = 0;
    const result = await withQuietStdout(() => textInput({
      row: 3, col: 1, width: 80, initialText: '',
      host: { control },
      internalTurnYield: gate.port,
      readKey: async () => {
        reads += 1;
        if (reads === 1) {
          expect(gate.startTurnIfIdle('자동', { origin: 'autowake' }).opened).toBe(true);
          return enter; // 사람 Enter 가 빈 키보다 먼저 배달됐다
        }
        return enter;
      },
    }));
    expect(result.yieldedToInternalTurn).toBeUndefined();
    expect(gate.takePending()).toBeNull();
    expect(gate.lastTurnId()).toBeNull();
  });

  test('물러남 예약 뒤 사람 키가 먼저 오면 textInput 은 물러나지 않고 문이 턴을 거둔다', async () => {
    const control: NonNullable<TextInputHost['control']> = { repaint: () => {} };
    const logs: LogRow[] = [];
    const gate = createInternalTurnGate({
      isEnabled: () => true,
      isTurnRunning: () => false,
      getBufferText: () => control.getBufferText?.(),
      getTypeaheadCount: () => 0,
      pendingKeyCount: () => 0,
      lastHumanKeyAt: () => 0,
      log: (category, event, data) => { logs.push({ category, event, data }); },
    });
    let reads = 0;
    const result = await withQuietStdout(() => textInput({
      row: 3, col: 1, width: 80, initialText: '',
      host: { control },
      internalTurnYield: gate.port,
      readKey: async () => {
        reads += 1;
        if (reads === 1) {
          gate.startTurnIfIdle('자동', { origin: 'autowake' });
          return { name: 'a', ctrl: false, shift: false }; // 경합: 사람 글자가 먼저 배달됐다
        }
        return enter;
      },
    }));
    expect(result).toEqual({ text: 'a', submitted: true });
    expect(gate.takePending()).toBeNull();
    expect(logs.at(-1)).toMatchObject({ event: 'rejected', data: { reason: 'HumanTyping', detail: 'late:buffer' } });
  });
});

describe('대시보드 배선 — 입력 루프가 «분기 함수»를 한 번 거쳐 턴 경로로 간다', () => {
  // ⚠️ showDashboard 안의 지역 루프는 단위 시험이 닿지 않는다 — 결선(호출 1회 · 그 결과가 postTurn·제출 의도로
  //   흐름)만 글자로 문다. 실제 턴이 도는지는 착지 뒤 라이브(TF)가 맡는다.
  const src = readFileSync(resolve(import.meta.dir, '../index.ts'), 'utf8');
  test('consumeInternalTurnYield 를 한 번 부르고, 그 input 이 postTurn 으로, 그 request 가 plain 제출 의도로 간다', () => {
    expect(src.match(/consumeInternalTurnYield\(internalTurnGate, input\)/g)).toHaveLength(1);
    const at = src.indexOf('consumeInternalTurnYield(internalTurnGate, input)');
    const post = src.indexOf('resolveDashboardChatMainPostTurn(input', at);
    expect(post).toBeGreaterThan(at);
    expect(src.slice(at, post)).toContain('input = consumed.input;');
    expect(src).toContain('? resolveInternalTurnSubmitIntent(internalTurn, dashboardAcpSession.currentSessionId)');
    // H3(seat-autowake)·자식 완료 깨움(agent-wake)이 문 port 를 감싸 «마운트 = 턴 끝 판정 시점»으로 잇는다 — 감싼 것도 같은 문이다.
    expect(src).toContain('const internalTurnYieldPort = wrapAgentWakePort(seatAutowake.wrapPort(internalTurnGate.port));');
    expect(src).toContain('internalTurnYield: internalTurnYieldPort,');
    expect(src).toContain('if (postTurn.historyRecord && !internalTurn) {');
  });
});
