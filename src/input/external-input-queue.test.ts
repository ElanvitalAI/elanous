import { describe, expect, test } from 'bun:test';
import {
  EXTERNAL_INPUT_QUEUE_LIMIT,
  createExternalInputQueue,
  decideExternalInputRoute,
  STALE_TURN_SUSPECTED_MS,
  parseExternalTextLine,
  renderExternalInputQueueNotice,
  isExternalStopCommand,
  withExternalKeyCommand,
  type ExternalInputHost,
} from './external-input-queue.js';
import type { InputSourceRef } from './input-source-kind.js';

function fakeHost(init: { turn?: boolean; composer?: string | undefined } = {}) {
  const state = { turn: init.turn ?? false, composer: 'composer' in init ? init.composer : '' as string | undefined, keys: 0 };
  const submitted: Array<{ text: string; source: InputSourceRef }> = [];
  const events: Array<{ event: string; pending: number }> = [];
  const host: ExternalInputHost = {
    isTurnActive: () => state.turn,
    composerText: () => state.composer,
    hasPendingKeys: () => state.keys > 0,
    submit: (text, source) => { submitted.push({ text, source }); return true; },
    onQueueChange: (pending, event) => { events.push({ event, pending: pending.length }); },
  };
  return { state, host, submitted, events };
}

function manualQueue(clock: { now?: () => number } = {}) {
  const logs: Array<{ event: string; data: Record<string, unknown> }> = [];
  let ticks: (() => void) | null = null;
  const q = createExternalInputQueue({
    now: clock.now ?? (() => 1000),
    schedule: (tick) => { ticks = tick; return () => { ticks = null; }; },
    log: (event, data) => logs.push({ event, data }),
  });
  return { q, logs, pumpScheduled: () => ticks !== null };
}

describe('parseExternalTextLine', () => {
  test('글 한 줄 ⊕ 끝 CR 은 제출, CR 없으면 채우기', () => {
    expect(parseExternalTextLine('깨어나라 OP\r')).toEqual({ text: '깨어나라 OP', submit: true });
    expect(parseExternalTextLine('hello')).toEqual({ text: 'hello', submit: false });
    expect(parseExternalTextLine(' \r')).toEqual({ text: ' ', submit: true });
  });
  test('제어 문자·명명 키·빈 글은 키 주입 경로(null)', () => {
    expect(parseExternalTextLine('\x1b')).toBeNull();
    expect(parseExternalTextLine('\x1b[A')).toBeNull();
    expect(parseExternalTextLine('\r')).toBeNull();
    expect(parseExternalTextLine('a\nb\r')).toBeNull();
    expect(parseExternalTextLine('\t')).toBeNull();
  });
});

describe('decideExternalInputRoute', () => {
  const line = { text: 'x', submit: true };
  test('판정표', () => {
    const base = { line, hostRegistered: true, pendingCount: 0, turnActive: false, composerText: '' as string | undefined };
    expect(decideExternalInputRoute({ ...base, line: null }).decision).toBe('passthrough');
    expect(decideExternalInputRoute({ ...base, hostRegistered: false }).decision).toBe('passthrough');
    expect(decideExternalInputRoute({ ...base, turnActive: true })).toEqual({ decision: 'queue', reason: 'turn-active' });
    expect(decideExternalInputRoute({ ...base, composerText: '치던 중' })).toEqual({ decision: 'queue', reason: 'user-buffer-nonempty' });
    expect(decideExternalInputRoute({ ...base, pendingCount: 1 })).toEqual({ decision: 'queue', reason: 'queue-nonempty' });
    // 공백만 있는 초안도 사용자 버퍼다.
    expect(decideExternalInputRoute({ ...base, composerText: '  ' })).toEqual({ decision: 'queue', reason: 'user-buffer-nonempty' });
    // 턴 밖 패널·모달은 대기열이 있어도 종전 키 주입.
    expect(decideExternalInputRoute({ ...base, composerText: undefined, pendingCount: 2 }).decision).toBe('passthrough');
    expect(decideExternalInputRoute({ ...base, composerText: undefined, turnActive: true }).decision).toBe('queue');
    expect(decideExternalInputRoute(base).decision).toBe('submit-now');
    const noEnter = { text: 'x', submit: false };
    expect(decideExternalInputRoute({ ...base, line: noEnter }).decision).toBe('passthrough');
    expect(decideExternalInputRoute({ ...base, line: noEnter, turnActive: true })).toEqual({ decision: 'reject', reason: 'turn-active-no-enter' });
    expect(decideExternalInputRoute({ ...base, line: noEnter, composerText: 'a' })).toEqual({ decision: 'reject', reason: 'user-buffer-nonempty-no-enter' });
  });
});

describe('createExternalInputQueue', () => {
  test('호스트가 없으면 종전대로 키 주입(passthrough)', () => {
    const { q } = manualQueue();
    expect(q.route('hello\r')).toBe('passthrough');
    expect(q.pending()).toHaveLength(0);
  });

  test('사용자 버퍼에 글자가 있으면 버퍼 불변 ⊕ 별도 항목으로 대기', () => {
    const { q, logs, pumpScheduled } = manualQueue();
    const h = fakeHost({ composer: '사용자 치던 줄' });
    q.register(h.host);
    expect(q.route('외부 지시\r')).toBe('queued');
    expect(h.state.composer).toBe('사용자 치던 줄');
    expect(h.submitted).toEqual([]);
    expect(q.pending()).toEqual([{ text: '외부 지시', at: 1000 }]);
    expect(h.events).toEqual([{ event: 'queued', pending: 1 }]);
    expect(pumpScheduled()).toBe(true);
    expect(logs.find((l) => l.event === 'route')?.data).toMatchObject({ route: 'queued', reason: 'user-buffer-nonempty', userBufferLength: '사용자 치던 줄'.length });
    // 버퍼가 남아 있는 동안은 나가지 않는다.
    expect(q.pump()).toBe(false);
    expect(h.state.composer).toBe('사용자 치던 줄');
    // 사용자가 자기 줄을 보내 composer 가 비면 «별도» 메시지로 나간다.
    h.state.composer = '';
    expect(q.pump()).toBe(true);
    expect(h.submitted).toEqual([{ text: '외부 지시', source: { kind: 'terminal', provider: 'pty' } }]);
    expect(q.pending()).toHaveLength(0);
    expect(pumpScheduled()).toBe(false);
  });

  test('턴 중 주입 → 턴이 끝난 뒤 별도 메시지 · FIFO 순서', () => {
    const { q } = manualQueue();
    const h = fakeHost({ turn: true, composer: undefined });
    q.register(h.host);
    expect(q.route('첫째\r')).toBe('queued');
    h.state.turn = false; h.state.composer = '';
    // 앞선 항목이 대기 중이면 뒤 항목도 앞지르지 않고 줄을 선다.
    expect(q.route('둘째\r')).toBe('queued');
    expect(q.pump()).toBe(true);
    expect(h.submitted.map((s) => s.text)).toEqual(['첫째']);
    // 제출 직후 composer 가 내려가고 다음 턴이 돈다 — 그동안은 나가지 않는다.
    h.state.composer = undefined; h.state.turn = true;
    expect(q.pump()).toBe(false);
    h.state.turn = false; h.state.composer = '';
    expect(q.pump()).toBe(true);
    expect(h.submitted.map((s) => s.text)).toEqual(['첫째', '둘째']);
  });

  test('공백만 있는 외부 글도 사용자 초안에 붙지 않고 대기·거부', () => {
    const { q } = manualQueue();
    const h = fakeHost({ composer: '초안' });
    q.register(h.host);
    expect(q.route(' \r')).toBe('queued');
    expect(() => q.route(' ')).toThrow('tui-busy-text-without-enter');
    expect(h.state.composer).toBe('초안');
  });

  test('composer 가 비어 보여도 키 큐에 사용자 키가 남아 있으면 대기 → 키가 다 소비된 뒤 전송', () => {
    const { q, logs } = manualQueue();
    const h = fakeHost();
    h.state.keys = 2;
    q.register(h.host);
    expect(q.route('외부\r')).toBe('queued');
    expect(logs.find((l) => l.event === 'route')?.data).toMatchObject({ reason: 'user-keys-pending', pendingKeys: true });
    expect(q.pump()).toBe(false);
    expect(h.submitted).toEqual([]);
    // 사용자 키가 소비돼 composer 에 글이 생기면 여전히 기다린다.
    h.state.keys = 0; h.state.composer = 'ab';
    expect(q.pump()).toBe(false);
    h.state.composer = '';
    expect(q.pump()).toBe(true);
    expect(h.submitted.map((s) => s.text)).toEqual(['외부']);
    // Enter 없는 글도 같은 이유로 거부.
    h.state.keys = 1;
    expect(() => q.route('초안')).toThrow('tui-busy-text-without-enter');
  });

  test('한가하고 composer 가 비면 출처를 단 별도 제출로 즉시', () => {
    const { q } = manualQueue();
    const h = fakeHost();
    q.register(h.host);
    expect(q.route('지금\r')).toBe('submitted');
    expect(h.submitted).toEqual([{ text: '지금', source: { kind: 'terminal', provider: 'pty' } }]);
    expect(q.pending()).toHaveLength(0);
  });

  test('Enter 없는 글은 바쁘면 거부(대기시키지 않는다 — 나중에 채우면 다시 섞인다)', () => {
    const { q } = manualQueue();
    const h = fakeHost({ turn: true, composer: undefined });
    q.register(h.host);
    expect(() => q.route('초안')).toThrow('tui-busy-text-without-enter');
    h.state.turn = false; h.state.composer = '치던 중';
    expect(() => q.route('초안')).toThrow('tui-busy-text-without-enter');
    expect(h.state.composer).toBe('치던 중');
    expect(q.pending()).toHaveLength(0);
    h.state.composer = '';
    expect(q.route('초안')).toBe('passthrough');
  });

  test('공백만 있는 초안 위에서는 나가지 않는다', () => {
    const { q } = manualQueue();
    const h = fakeHost({ turn: true });
    q.register(h.host);
    q.route('x\r');
    h.state.turn = false; h.state.composer = ' ';
    expect(q.pump()).toBe(false);
    expect(h.submitted).toEqual([]);
  });

  test('키(제어 문자)·composer 밖(패널)은 종전대로 passthrough', () => {
    const { q } = manualQueue();
    const h = fakeHost({ turn: true });
    q.register(h.host);
    expect(q.route('\x1b')).toBe('passthrough');
    h.state.turn = false; h.state.composer = undefined;
    expect(q.route('j')).toBe('passthrough');
  });

  test('input-key(withExternalKeyCommand) 안의 쓰기는 출력 가능한 키도 종전대로 통과', () => {
    const { q } = manualQueue();
    const h = fakeHost({ turn: true });
    q.register(h.host);
    expect(withExternalKeyCommand(() => q.route(' '))).toBe('passthrough');
    expect(withExternalKeyCommand(() => q.route('j'))).toBe('passthrough');
    expect(() => q.route('j')).toThrow('tui-busy-text-without-enter');
  });

  test('대기열 상한을 넘으면 throw → IPC 가 실패로 정산', () => {
    const { q } = manualQueue();
    q.register(fakeHost({ turn: true }).host);
    for (let i = 0; i < EXTERNAL_INPUT_QUEUE_LIMIT; i++) q.route(`m${i}\r`);
    expect(() => q.route('넘침\r')).toThrow('tui-external-input-queue-full');
  });

  test('turn-active 머리가 10분을 넘기면 stale-turn-suspected 를 한 번만 남기고 대기열은 유지', () => {
    let t = 1000;
    const { q, logs } = manualQueue({ now: () => t });
    const h = fakeHost({ turn: true, composer: '' });
    q.register(h.host);
    expect(q.route('갇힌 입력\r')).toBe('queued');
    t = 1000 + STALE_TURN_SUSPECTED_MS - 1;
    expect(q.pump()).toBe(false);
    expect(logs.filter((l) => l.event === 'stale-turn-suspected')).toHaveLength(0);
    t = 1000 + STALE_TURN_SUSPECTED_MS;
    expect(q.pump()).toBe(false);
    expect(q.pump()).toBe(false);
    const stale = logs.filter((l) => l.event === 'stale-turn-suspected');
    expect(stale).toHaveLength(1);
    expect(stale[0]?.data).toMatchObject({ waitedMs: STALE_TURN_SUSPECTED_MS, pending: 1 });
    expect(q.pending()).toEqual([{ text: '갇힌 입력', at: 1000 }]);
    expect(h.state.turn).toBe(true);
    expect(h.submitted).toEqual([]);
  });

  test('stale 경고 뒤 제출 실패로 같은 머리가 남으면 경고를 다시 남기지 않고, 머리가 바뀌면 다시 남긴다', () => {
    let t = 1000;
    const { q, logs } = manualQueue({ now: () => t });
    const h = fakeHost({ turn: true, composer: '' });
    let accept = false;
    h.host.submit = (text, source) => { if (!accept) return false; h.submitted.push({ text, source }); return true; };
    q.register(h.host);
    expect(q.route('첫 입력\r')).toBe('queued');
    expect(q.route('둘째 입력\r')).toBe('queued');
    const staleCount = () => logs.filter((l) => l.event === 'stale-turn-suspected').length;
    t = 1000 + STALE_TURN_SUSPECTED_MS;
    expect(q.pump()).toBe(false);
    expect(staleCount()).toBe(1);
    h.state.turn = false;
    expect(q.pump()).toBe(false);
    expect(logs.some((l) => l.event === 'deliver-failed')).toBe(true);
    h.state.turn = true;
    expect(q.pump()).toBe(false);
    expect(staleCount()).toBe(1);
    expect(q.pending().map((i) => i.text)).toEqual(['첫 입력', '둘째 입력']);
    accept = true;
    h.state.turn = false;
    expect(q.pump()).toBe(true);
    h.state.turn = true;
    expect(q.pump()).toBe(false);
    expect(staleCount()).toBe(2);
    expect(q.pending().map((i) => i.text)).toEqual(['둘째 입력']);
  });

  test('제출 실패면 항목을 남긴다', () => {
    const { q, logs } = manualQueue();
    const h = fakeHost({ turn: true });
    h.host.submit = () => false;
    q.register(h.host);
    q.route('x\r');
    h.state.turn = false;
    expect(q.pump()).toBe(false);
    expect(q.pending()).toHaveLength(1);
    expect(logs.some((l) => l.event === 'deliver-failed')).toBe(true);
  });
});

describe('renderExternalInputQueueNotice', () => {
  test('건수 ⊕ 머리 내용', () => {
    expect(renderExternalInputQueueNotice([])).toBeNull();
    expect(renderExternalInputQueueNotice([{ text: '깨어나라', at: 0 }]))
      .toBe('⤵ 외부 입력 1건 대기 · "깨어나라" · 턴이 끝나고 입력창이 비면 별도 메시지로 전송');
  });
});

describe('외부 /stop — 대기열 건너뛰기 (TUI-STOP-INPUT-BYPASS · #68)', () => {
  function stopHost(init: { turn?: boolean; stopOk?: boolean } = {}) {
    const f = fakeHost({ turn: init.turn ?? true });
    const stops: number[] = [];
    const results: string[] = [];
    f.host.requestStop = () => { stops.push(1); return init.stopOk ?? true; };
    f.host.onExternalStop = (r) => { results.push(r); };
    return { ...f, stops, results };
  }
  function stopQueue() {
    const inputLogs: Array<{ event: string; data: Record<string, unknown> }> = [];
    const q = createExternalInputQueue({
      now: () => 1000,
      schedule: () => () => {},
      log: () => {},
      logInput: (event, data) => inputLogs.push({ event, data }),
    });
    return { q, inputLogs };
  }

  test('정확히 /stop·/esc 만 stop 명령이다', () => {
    expect(isExternalStopCommand('/stop')).toBe(true);
    expect(isExternalStopCommand('/esc')).toBe(true);
    expect(isExternalStopCommand(' /stop')).toBe(false);
    expect(isExternalStopCommand('/stop now')).toBe(false);
    expect(isExternalStopCommand('/STOP')).toBe(false);
    expect(isExternalStopCommand('stop')).toBe(false);
  });

  test('턴 중 /stop → 대기열을 건너뛰고 escGate 1회 · 앞선 대기 항목 순서 유지', () => {
    const { q, inputLogs } = stopQueue();
    const h = stopHost({ turn: true });
    q.register(h.host);
    expect(q.route('첫째\r')).toBe('queued');
    expect(q.route('둘째\r')).toBe('queued');
    expect(q.route('/stop\r')).toBe('stopped');
    expect(h.stops.length).toBe(1);
    expect(h.results).toEqual(['stopped']);
    expect(q.pending().map((i) => i.text)).toEqual(['첫째', '둘째']);
    expect(h.submitted).toEqual([]);
    expect(inputLogs).toEqual([{ event: 'external-stop', data: { hadTurn: true, stopped: true, command: '/stop', pending: 2 } }]);
    // 턴이 끝나면 일반 항목은 종전대로 FIFO 로 나간다.
    h.state.turn = false;
    expect(q.pump()).toBe(true);
    expect(q.pump()).toBe(true);
    expect(h.submitted.map((s) => s.text)).toEqual(['첫째', '둘째']);
  });

  test('Enter 없는 /esc 도 턴 중이면 멈춘다(거부되지 않는다)', () => {
    const { q } = stopQueue();
    const h = stopHost({ turn: true });
    q.register(h.host);
    expect(q.route('/esc')).toBe('stopped');
    expect(h.stops.length).toBe(1);
  });

  test('턴이 없으면 /stop 은 무시 ⊕ 이벤트 ⊕ 안내(throw → IPC rc≠0) · 사용자 composer 에 안 들어간다', () => {
    const { q, inputLogs } = stopQueue();
    const h = stopHost({ turn: false });
    q.register(h.host);
    expect(() => q.route('/stop\r')).toThrow('tui-stop-no-active-turn');
    expect(h.stops.length).toBe(0);
    expect(h.submitted).toEqual([]);
    expect(q.pending()).toEqual([]);
    expect(h.results).toEqual(['no-turn']);
    expect(inputLogs[0]).toEqual({ event: 'external-stop', data: { hadTurn: false, stopped: false, command: '/stop', pending: 0 } });
  });

  test('턴 중인데 중단 경로가 없으면 undelivered 로 알린다', () => {
    const { q } = stopQueue();
    const h = stopHost({ turn: true, stopOk: false });
    q.register(h.host);
    expect(() => q.route('/stop\r')).toThrow('tui-stop-undelivered');
    expect(h.results).toEqual(['failed']);
  });

  test('일반 외부 입력은 여전히 대기 · /stop 비슷한 글도 일반 글이다', () => {
    const { q } = stopQueue();
    const h = stopHost({ turn: true });
    q.register(h.host);
    expect(q.route('그만 멈춰\r')).toBe('queued');
    expect(q.route('/stop now\r')).toBe('queued');
    expect(h.stops.length).toBe(0);
    expect(q.pending().map((i) => i.text)).toEqual(['그만 멈춰', '/stop now']);
  });

  test('pty key(withExternalKeyCommand) 안의 /stop 은 키로 통과 — stop 을 안 탄다', () => {
    const { q } = stopQueue();
    const h = stopHost({ turn: true });
    q.register(h.host);
    expect(withExternalKeyCommand(() => q.route('/stop'))).toBe('passthrough');
    expect(h.stops.length).toBe(0);
  });
});
