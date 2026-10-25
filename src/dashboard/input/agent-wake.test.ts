import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  globalTaskNotificationQueue,
  TaskNotificationQueue,
  type PendingTaskNotification,
} from '../../agent/task-notification.js';
import type { getUserConfig } from '../../user-config.js';
import { buildDashboardTurnPreamble } from '../turn-preamble.js';
import {
  agentWakeBeforeExitHook,
  createAgentWake,
  createDashboardAgentWakeNotify,
  formatAgentWakeNotice,
  formatAgentWakePrompt,
  installAgentWake,
  installSeatedAgentWake,
  resetAgentWakeForTest,
  wrapAgentWakePort,
  type AgentWakeOpenTurnDeps,
} from './agent-wake.js';
import { createInternalTurnGate, type StartTurnIfIdleOptions } from './internal-turn.js';

type LogRow = { category: string; event: string; data: Record<string, unknown> };

function pending(taskId: string, over: Partial<PendingTaskNotification> = {}): PendingTaskNotification {
  return {
    taskId,
    agentName: 'general-purpose',
    label: 'pr-review',
    state: 'done',
    output: 'ok',
    truncated: false,
    durationMs: 1200,
    finishedAt: 1,
    ...over,
  };
}

function harness() {
  const logs: LogRow[] = [];
  const lines: string[] = [];
  const queue = new TaskNotificationQueue();
  const wake = createAgentWake({
    subscribe: (listener) => queue.onEnqueue(listener),
    notify: (line) => { lines.push(line); },
    log: (category, event, data) => { logs.push({ category, event, data }); },
  });
  return { queue, wake, lines, logs };
}

afterEach(() => { resetAgentWakeForTest(); });

describe('agent-wake — 배경 자식 완료를 쉬는 TUI 에 알린다(비침투 · 조각 1 = 알림만)', () => {
  test('완료 enqueue → 채팅 한 줄 1 ⊕ 큐는 그대로(결과는 다음 턴이 꺼낸다)', () => {
    const h = harness();
    h.queue.enqueue(pending('t1'));
    expect(h.lines).toEqual(['✓ 위임 끝: pr-review — 다음 턴에 결과']);
    expect(h.queue.size).toBe(1);
    expect(h.logs).toEqual([{ category: 'tui.agent-wake', event: 'notified', data: { taskId: 't1', agent: 'general-purpose', state: 'done', shown: true } }]);
  });

  test('같은 알림 재enqueue(큐 clear 뒤 포함) → 정확히 한 번', () => {
    const h = harness();
    h.queue.enqueue(pending('t1'));
    h.queue.enqueue(pending('t1')); // 큐 seen 이 막는다
    h.queue.clear(); // seen 이 비워져도
    h.queue.enqueue(pending('t1')); // 여기서 막는다
    expect(h.lines).toHaveLength(1);
    expect(h.logs.at(-1)).toMatchObject({ event: 'rejected', data: { taskId: 't1', reason: 'duplicate' } });
  });

  test('여러 자식 완료 → 각각 한 줄', () => {
    const h = harness();
    h.queue.enqueue(pending('t1'));
    const shell = pending('t2', { agentName: 'RunShell', state: 'error' });
    delete shell.label;
    h.queue.enqueue(shell);
    expect(h.lines).toEqual(['✓ 위임 끝: pr-review — 다음 턴에 결과', '✗ 위임 끝: RunShell (error) — 다음 턴에 결과']);
  });

  test('그리기가 실패해도 큐·형제는 이어지고 관측에 남는다(shown:false)', () => {
    const logs: LogRow[] = [];
    const queue = new TaskNotificationQueue();
    let sibling = 0;
    createAgentWake({
      subscribe: (l) => queue.onEnqueue(l),
      notify: () => { throw new Error('torn down'); },
      log: (category, event, data) => { logs.push({ category, event, data }); },
    });
    queue.onEnqueue(() => { sibling += 1; });
    queue.enqueue(pending('t1'));
    expect(sibling).toBe(1);
    expect(queue.size).toBe(1);
    expect(logs[0]).toMatchObject({ event: 'notified', data: { shown: false, notifyError: 'torn down' } });
  });

  test('대시보드 notify(배선이 쓰는 그 함수) — draw() 실패가 shown:false 로 남는다 · 성공은 shown:true', () => {
    const logs: LogRow[] = [];
    const pushed: string[] = [];
    let drawFails = true;
    const queue = new TaskNotificationQueue();
    createAgentWake({
      subscribe: (l) => queue.onEnqueue(l),
      notify: createDashboardAgentWakeNotify((line) => { pushed.push(line); }, () => { if (drawFails) throw new Error('draw failed'); }),
      log: (category, event, data) => { logs.push({ category, event, data }); },
    });
    queue.enqueue(pending('t1'));
    drawFails = false;
    queue.enqueue(pending('t2'));
    expect(pushed).toHaveLength(2);
    expect(logs.map(l => [l.data.taskId, l.data.shown, l.data.notifyError ?? null])).toEqual([
      ['t1', false, 'draw failed'],
      ['t2', true, null],
    ]);
  });

  test('빈 메시지 예외(new Error(\'\'))도 notifyError 칸이 남는다', () => {
    const logs: LogRow[] = [];
    const queue = new TaskNotificationQueue();
    createAgentWake({
      subscribe: (l) => queue.onEnqueue(l),
      notify: createDashboardAgentWakeNotify(() => {}, () => { throw new Error(''); }),
      log: (category, event, data) => { logs.push({ category, event, data }); },
    });
    queue.enqueue(pending('t1'));
    expect(logs[0]!.data).toMatchObject({ shown: false, notifyError: '' });
    expect('notifyError' in logs[0]!.data).toBe(true);
  });

  test('dispose 뒤엔 구독이 풀린다 · 두 번 불러도 안전', () => {
    const h = harness();
    h.wake.dispose();
    h.wake.dispose();
    h.queue.enqueue(pending('t1'));
    expect(h.lines).toHaveLength(0);
  });

  test('알림 문면 — 공백 접기 · 라벨 없으면 에이전트 이름 · 중단은 ✗', () => {
    expect(formatAgentWakeNotice({ agentName: 'RunShell', label: '  bun   test ', state: 'error' })).toBe('✗ 위임 끝: bun test (error) — 다음 턴에 결과');
    expect(formatAgentWakeNotice({ agentName: 'Explore', state: 'aborted' })).toBe('✗ 위임 끝: Explore (aborted) — 다음 턴에 결과');
  });

  test('모듈은 입력칸 주입 길(injectKey · submit · pty)을 부르지 않는다', () => {
    const src = readFileSync(resolve(import.meta.dir, 'agent-wake.ts'), 'utf8')
      .split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
    // 턴은 H2 문(`startTurnIfIdle`)으로만 연다(조각 2) — 입력칸 주입 길은 여전히 0.
    expect(src).not.toMatch(/injectKey\(|\.submit\(|pty text|routeExternalInput|setBufferText|prefill|requestYield\(/);
  });
});

describe('대시보드 수명 — 재진입·종료에도 구독은 언제나 하나 · dedupe 는 설치를 가로지른다', () => {
  const deps = (queue: TaskNotificationQueue, lines: string[], tag: string) => ({
    subscribe: (l: (n: PendingTaskNotification) => void) => queue.onEnqueue(l),
    notify: (line: string) => { lines.push(`${tag}:${line}`); },
    log: () => {},
  });

  test('재진입(install 두 번) → 앞 구독이 풀려 완료 한 건에 알림 하나', () => {
    const queue = new TaskNotificationQueue();
    const lines: string[] = [];
    installAgentWake(deps(queue, lines, 'first'));
    installAgentWake(deps(queue, lines, 'second'));
    queue.enqueue(pending('t1'));
    expect(lines).toEqual(['second:✓ 위임 끝: pr-review — 다음 턴에 결과']);
  });

  test('늦게 닫힌 앞 대시보드의 dispose 는 자기 것만 — 새 대시보드 구독은 산다', () => {
    const queue = new TaskNotificationQueue();
    const lines: string[] = [];
    const old = installAgentWake(deps(queue, lines, 'old'));
    installAgentWake(deps(queue, lines, 'new'));
    old.dispose();
    queue.enqueue(pending('t1'));
    expect(lines).toEqual(['new:✓ 위임 끝: pr-review — 다음 턴에 결과']);
  });

  test('자기 대시보드 종료(dispose) 뒤엔 닫힌 TUI 에 그리지 않는다', () => {
    const queue = new TaskNotificationQueue();
    const lines: string[] = [];
    const own = installAgentWake(deps(queue, lines, 'a'));
    own.dispose();
    queue.enqueue(pending('t1'));
    expect(lines).toEqual([]);
  });

  test('재진입 N회 뒤에도 beforeExit 정리 리스너는 1개 · 그 리스너가 지금 설치를 푼다', () => {
    const queue = new TaskNotificationQueue();
    const lines: string[] = [];
    installAgentWake(deps(queue, lines, 'd0'));
    const afterFirst = process.listenerCount('beforeExit');
    for (let i = 1; i < 5; i++) installAgentWake(deps(queue, lines, `d${i}`));
    // 재진입이 리스너를 하나도 더하지 않는다(설치마다 클로저를 거는 꼴이면 늘어난다).
    expect(process.listenerCount('beforeExit')).toBe(afterFirst);
    expect(process.listeners('beforeExit').filter(f => f === agentWakeBeforeExitHook)).toHaveLength(1);
    agentWakeBeforeExitHook();
    queue.enqueue(pending('t1'));
    expect(lines).toEqual([]);
  });

  test('재진입 뒤 큐 clear ⊕ 같은 taskId → 다시 알리지 않는다', () => {
    const queue = new TaskNotificationQueue();
    const lines: string[] = [];
    installAgentWake(deps(queue, lines, 'first'));
    queue.enqueue(pending('t1'));
    installAgentWake(deps(queue, lines, 'second'));
    queue.clear();
    queue.enqueue(pending('t1'));
    expect(lines).toEqual(['first:✓ 위임 끝: pr-review — 다음 턴에 결과']);
  });
});

describe('«다음 턴에 결과» — 알림이 결과를 먹지 않고 실제 다음 턴 preamble 에 실린다', () => {
  test('실물 전역 큐 ⊕ 설치 ⊕ buildDashboardTurnPreamble: 고유 output 이 한 번 실리고 큐는 비워진다', () => {
    const fakeConfig = { chat: { conciseness: 'balanced' } } as unknown as ReturnType<typeof getUserConfig>;
    const lines: string[] = [];
    globalTaskNotificationQueue.clear();
    installAgentWake({ subscribe: (l) => globalTaskNotificationQueue.onEnqueue(l), notify: (line) => { lines.push(line); }, log: () => {} });
    const unique = `agent-wake-result-${Date.now()}-${Math.random()}`;
    globalTaskNotificationQueue.enqueue(pending('agent-wake-e2e', { output: unique }));
    expect(lines).toEqual(['✓ 위임 끝: pr-review — 다음 턴에 결과']);
    expect(globalTaskNotificationQueue.size).toBe(1);

    const cwd = mkdtempSync(join(tmpdir(), 'agent-wake-preamble-'));
    let turn: ReturnType<typeof buildDashboardTurnPreamble>;
    try { turn = buildDashboardTurnPreamble({ userText: 'continue', cwd, userConfig: fakeConfig }); }
    finally { rmSync(cwd, { recursive: true, force: true }); }
    const carried = turn.filter((m) => m.role === 'user' && String(m.content).includes(unique));
    expect(carried).toHaveLength(1);
    expect(String(carried[0]!.content)).toContain('<task-notification>');
    expect(globalTaskNotificationQueue.size).toBe(0);
    globalTaskNotificationQueue.clear();
  }, 120_000); // 콜드 기동(임시 git·preamble 조립)에서 bun 기본 5s 를 넘긴다 — K-OP-035.
});

describe('대시보드 배선 — 글자로 문다(showDashboard 지역 배선은 단위 시험이 닿지 않는다 · 라이브는 착지 뒤 TF)', () => {
  const src = readFileSync(resolve(import.meta.dir, '../index.ts'), 'utf8');
  test('task-notification onEnqueue 구독 정확히 1 · 설치 경로로만 · 주입 길 0', () => {
    // TUI-SUBAGENT-RESULT-CAP — 구독은 subscribeDashboardAgentResults 한 곳을 지난다(onEnqueue 깨움 ⊕ onDrain 이력).
    expect(src.match(/\.onEnqueue\(/g)).toHaveLength(1);
    expect(src).toContain('const offWake = queue.onEnqueue(listener);');
    expect(src.match(/subscribeDashboardAgentResults\(\s*globalTaskNotificationQueue,/g)).toHaveLength(1);
    expect(src.match(/installSeatedAgentWake\(\{/g)).toHaveLength(1);
    expect(src).not.toMatch(/createAgentWake\(/);
    const at = src.indexOf('const agentWake = installSeatedAgentWake({');
    expect(at).toBeGreaterThan(0);
    const block = src.slice(at, src.indexOf('    });\n', at));
    expect(block).toMatch(/subscribe: \(listener\) => subscribeDashboardAgentResults\(\s*globalTaskNotificationQueue, listener,/);
    expect(block).not.toMatch(/injectKey|hostControl|\.submit\(/);
    // 조각 2 — 턴은 H2 문으로만 · 판정 근거는 같은 큐 · cwd 는 지금 화면.
    expect(block).toContain('startTurnIfIdle: (text, opts) => internalTurnGate.startTurnIfIdle(text, opts)');
    expect(block).toContain('isPending: (taskId) => globalTaskNotificationQueue.has(taskId)');
    expect(block).toContain('getCwd: () => workingDir.cwd');
    // 그리기 실패를 삼키지 않는 notify 를 쓴다(거짓 shown:true 방지).
    expect(block).toContain('notify: createDashboardAgentWakeNotify(');
    expect(block).not.toMatch(/catch/);
  });
  test('입력칸 문은 깨움 감싸기를 거친다(«대기» 재시도의 근거) · 감싸기는 정확히 1', () => {
    expect(src.match(/wrapAgentWakePort\(/g)).toHaveLength(1);
    expect(src).toContain('const internalTurnYieldPort = wrapAgentWakePort(goalContinue.wrapPort(seatAutowake.wrapPort(internalTurnGate.port)));');
  });
  test('대시보드 종료(closeDashboardTui)가 «자기» 구독을 푼다', () => {
    const at = src.indexOf('const closeDashboardTui = (): void => {');
    expect(at).toBeGreaterThan(0);
    expect(src.slice(at, src.indexOf('};', at))).toContain('disposeDashboardAgentWake();');
    expect(src).toContain('disposeDashboardAgentWake = () => agentWake.dispose();');
    // 종료 정리는 모듈의 리스너 하나 — 대시보드가 재진입마다 beforeExit 를 더하지 않는다.
    expect(src).not.toContain("process.once('beforeExit', () => agentWake.dispose());");
  });
});

// ── 조각 2 — 자리 TUI ∧ 유휴면 H2 문으로 다음 턴(TUI-AGENT-IDLE-WAKE-TURN) ─────────────────────
describe('조각 2 — 자식 완료 ∧ 자리 TUI ∧ 유휴 → H2 문으로 한 턴(origin child-complete)', () => {
  /** 진짜 H2 문 ⊕ 진짜 큐 — 대시보드가 넘기는 것과 같은 모양. */
  function seatHarness(over: { seat?: string | null; seatThrows?: boolean; queue?: TaskNotificationQueue; open?: boolean; isPendingThrows?: string } = {}) {
    const logs: LogRow[] = [];
    const lines: string[] = [];
    const state = { running: false, buffer: '' as string | undefined, yields: 0 };
    const queue = over.queue ?? new TaskNotificationQueue();
    const log = (category: string, event: string, data: Record<string, unknown>) => { logs.push({ category, event, data }); };
    const gate = createInternalTurnGate({
      isEnabled: () => true,
      isTurnRunning: () => state.running,
      getBufferText: () => state.buffer,
      getTypeaheadCount: () => 0,
      pendingKeyCount: () => 0,
      lastHumanKeyAt: () => 0,
      log,
    });
    // textInput 꼴: 버퍼가 비었을 때만 물러난다(입력칸 무접촉).
    const port = wrapAgentWakePort(gate.port);
    const mount = () => port.attach(() => { if (state.buffer) return false; state.yields++; return true; });
    const deferred: Array<() => void> = [];
    const openTurn: AgentWakeOpenTurnDeps = {
      startTurnIfIdle: (text, opts) => gate.startTurnIfIdle(text, opts),
      getCwd: () => '/home/x/elanous-hq/seats/OPC',
      isPending: (taskId) => {
        if (over.isPendingThrows) throw new Error(over.isPendingThrows);
        return queue.has(taskId);
      },
      detectSeat: () => {
        if (over.seatThrows) throw new Error('EACCES');
        const seat = over.seat === undefined ? 'OPC' : over.seat;
        return seat ? ({ seat, source: 'cwd' } as never) : null;
      },
      defer: (fn) => { deferred.push(fn); },
    };
    const wake = installAgentWake({
      subscribe: (l) => queue.onEnqueue(l),
      notify: (line) => { lines.push(line); },
      log,
      ...(over.open === false ? {} : { openTurn }),
    });
    const flush = () => { while (deferred.length) deferred.shift()!(); };
    const opened = () => logs.filter(r => r.category === 'tui.autoturn' && r.event === 'opened');
    const wakeRows = (event: string) => logs.filter(r => r.category === 'tui.agent-wake' && r.event === event);
    return { queue, gate, state, mount, port, wake, lines, logs, flush, opened, wakeRows };
  }

  test('자리 TUI ∧ 유휴: H2 정확히 1회 · origin child-complete · 버퍼 불변 · 알림 한 줄도 그대로', () => {
    const h = seatHarness();
    h.mount();
    h.queue.enqueue(pending('t1'));
    expect(h.opened()).toHaveLength(1);
    expect(h.opened()[0]!.data).toMatchObject({ origin: 'child-complete', reason: '위임 끝: pr-review' });
    expect(h.wakeRows('opened')[0]!.data).toMatchObject({ taskId: 't1', seat: 'OPC', trigger: 'enqueue' });
    const req = h.gate.takePending();
    expect(req).toMatchObject({ origin: 'child-complete', input: formatAgentWakePrompt(pending('t1')) });
    expect(h.state.buffer).toBe('');
    expect(h.lines).toEqual(['✓ 위임 끝: pr-review — 다음 턴에 결과']);
  });

  // ⚠️ 단위 결합: H2 요청을 꺼낸 뒤 preamble 함수를 직접 부른다 — 대시보드 턴 경로 결합은 라이브(PR 본문)가 본다.
  test('연 턴의 preamble 에 그 결과가 정확히 한 번 실린다(실물 전역 큐 ⊕ buildDashboardTurnPreamble)', () => {
    globalTaskNotificationQueue.clear();
    const h = seatHarness({ queue: globalTaskNotificationQueue });
    h.mount();
    const unique = `idle-wake-turn-${Date.now()}-${Math.random()}`;
    globalTaskNotificationQueue.enqueue(pending('wake-turn-e2e', { output: unique }));
    const req = h.gate.takePending();
    expect(req?.origin).toBe('child-complete');
    const fakeConfig = { chat: { conciseness: 'balanced' } } as unknown as ReturnType<typeof getUserConfig>;
    const cwd = mkdtempSync(join(tmpdir(), 'agent-wake-turn-'));
    let turn: ReturnType<typeof buildDashboardTurnPreamble>;
    try { turn = buildDashboardTurnPreamble({ userText: req!.input, cwd, userConfig: fakeConfig }); }
    finally { rmSync(cwd, { recursive: true, force: true }); }
    expect(turn.filter((m) => m.role === 'user' && String(m.content).includes(unique))).toHaveLength(1);
    expect(globalTaskNotificationQueue.size).toBe(0);
    globalTaskNotificationQueue.clear();
  }, 120_000); // 콜드 기동(임시 git·preamble 조립)에서 bun 기본 5s 를 넘긴다 — K-OP-035.

  test('턴 중(busy) → 그 순간 0 · «대기»(NotIdle) → 턴 끝나 입력칸이 다시 뜨면 아직 안 실린 결과로 1회', () => {
    const h = seatHarness();
    h.mount();
    h.state.running = true;
    h.queue.enqueue(pending('t1'));
    expect(h.opened()).toHaveLength(0);
    expect(h.wakeRows('deferred')[0]!.data).toMatchObject({ reason: 'NotIdle', detail: 'turn-running' });
    h.state.running = false;
    h.mount(); h.flush();
    expect(h.opened()).toHaveLength(1);
    expect(h.wakeRows('opened')[0]!.data).toMatchObject({ trigger: 'input-mounted' });
    // 재시도는 한 번 — 다시 떠도 더 열지 않는다.
    h.gate.takePending(); h.mount(); h.flush();
    expect(h.opened()).toHaveLength(1);
  });

  test('턴 중에 온 결과를 그 턴(또는 다음 사람 턴)이 이미 실었으면 다시 뜰 때 열지 않는다(already-carried)', () => {
    const h = seatHarness();
    h.mount();
    h.state.running = true;
    h.queue.enqueue(pending('t1'));
    h.queue.drain();
    h.state.running = false;
    h.mount(); h.flush();
    expect(h.opened()).toHaveLength(0);
    expect(h.wakeRows('rejected').at(-1)!.data).toMatchObject({ reason: 'already-carried' });
  });

  test('재시도 판정 중 isPending 이 던져도 깨움은 죽지 않고 사유 로그가 남는다(수복 경로의 관측 · reason error)', () => {
    const h = seatHarness({ isPendingThrows: 'queue gone' });
    h.mount();
    h.state.running = true;
    h.queue.enqueue(pending('t1')); // NotIdle → «대기»
    expect(h.wakeRows('deferred')).toHaveLength(1);
    h.state.running = false;
    h.mount(); h.flush();
    expect(h.opened()).toHaveLength(0);
    expect(h.wakeRows('rejected').at(-1)!.data).toMatchObject({
      taskId: 't1', trigger: 'input-mounted', reason: 'error', detail: 'queue gone',
    });
  });

  test('사람이 입력칸에 쓰는 중 → H2 거부 사유 HumanTyping 그대로 · 버퍼 무접촉 · 턴 0', () => {
    const h = seatHarness();
    h.mount();
    h.state.buffer = '쓰는 중';
    h.queue.enqueue(pending('t1'));
    expect(h.opened()).toHaveLength(0);
    expect(h.wakeRows('deferred')[0]!.data).toMatchObject({ reason: 'HumanTyping', detail: 'buffer' });
    expect(h.state.buffer).toBe('쓰는 중');
    expect(h.state.yields).toBe(0);
  });

  test('사람 대화 TUI → 알림만 · 턴 0(not-seat) · 자리 판정 실패도 0(seat-unknown)', () => {
    const human = seatHarness({ seat: null });
    human.mount();
    human.queue.enqueue(pending('t1'));
    expect(human.lines).toHaveLength(1);
    expect(human.opened()).toHaveLength(0);
    expect(human.wakeRows('rejected')[0]!.data).toMatchObject({ reason: 'not-seat' });
    resetAgentWakeForTest();
    const unknown = seatHarness({ seatThrows: true });
    unknown.mount();
    unknown.queue.enqueue(pending('t2'));
    expect(unknown.opened()).toHaveLength(0);
    expect(unknown.wakeRows('rejected')[0]!.data).toMatchObject({ reason: 'seat-unknown', detail: 'EACCES' });
  });

  test('반증 대조 — openTurn 을 안 넘기면(조각 1 배선) 자리 TUI ∧ 유휴여도 턴 0', () => {
    const h = seatHarness({ open: false });
    h.mount();
    h.queue.enqueue(pending('t1'));
    expect(h.lines).toHaveLength(1);
    expect(h.opened()).toHaveLength(0);
  });

  test('여러 자식이 겹쳐 끝나면 턴은 하나 — 둘째는 그 턴에 실리므로 다시 뜰 때 열지 않는다', () => {
    const h = seatHarness();
    h.mount();
    h.queue.enqueue(pending('t1'));
    h.queue.enqueue(pending('t2'));
    expect(h.opened()).toHaveLength(1);
    expect(h.wakeRows('deferred')[0]!.data).toMatchObject({ taskId: 't2', reason: 'NotIdle', detail: 'internal-turn-pending' });
    h.gate.takePending();
    h.queue.drain(); // 연 턴의 preamble 이 둘 다 실었다
    h.mount(); h.flush();
    expect(h.opened()).toHaveLength(1);
  });

  test('재진입 뒤 큐 clear ⊕ 같은 taskId → 턴도 정확히 1회', () => {
    const queue = new TaskNotificationQueue();
    const first = seatHarness({ queue });
    first.mount();
    queue.enqueue(pending('t1'));
    first.gate.takePending();
    const second = seatHarness({ queue });
    second.mount();
    queue.clear();
    queue.enqueue(pending('t1'));
    expect(first.opened().length + second.opened().length).toBe(1);
  });

  test('재시도 예약 뒤 대시보드가 닫히면(늦은 close) 예약 콜백은 옛 H2 문에 청하지 않는다', () => {
    const h = seatHarness();
    h.mount();
    h.state.running = true;
    h.queue.enqueue(pending('t1'));
    h.state.running = false;
    h.mount();          // 재시도 예약
    h.wake.dispose();   // 예약이 돌기 전에 닫힘
    h.flush();
    expect(h.opened()).toHaveLength(0);
  });

  test('예약 뒤 «그» 결과가 실리고 다른 결과가 큐에 들어와도 앞 완료로는 다시 청하지 않는다(taskId 기준)', () => {
    const h = seatHarness();
    h.mount();
    h.state.running = true;
    h.queue.enqueue(pending('t1'));   // deferred
    h.queue.drain();                  // t1 은 그 턴이 실었다
    h.queue.enqueue(pending('t2'));   // 다른 결과 — 턴 중이라 자기도 deferred(마지막 것으로 바뀜)
    h.state.running = false;
    h.mount(); h.flush();
    // 재시도는 t2(아직 큐에 있음)로 한 번 — t1 을 이유로는 안 연다.
    expect(h.wakeRows('opened').map(r => r.data.taskId)).toEqual(['t2']);
  });

  test('t1 이 이미 실렸으면 큐에 남은 다른 결과가 있어도 t1 재시도는 already-carried', () => {
    const queue = new TaskNotificationQueue();
    const h = seatHarness({ queue });
    h.mount();
    h.state.running = true;
    h.queue.enqueue(pending('t1'));
    h.queue.drain();
    // 큐에 남은 다른 결과(이 깨움이 알기 전에 쌓인 것 · 예: 조각 밖 경로)
    (queue as unknown as { queue: PendingTaskNotification[] }).queue.push(pending('other'));
    h.state.running = false;
    h.mount(); h.flush();
    expect(h.opened()).toHaveLength(0);
    expect(h.wakeRows('rejected').at(-1)!.data).toMatchObject({ taskId: 't1', reason: 'already-carried' });
  });

  test('앞 대시보드의 늦은 close 뒤에도 새 대시보드 구독이 살아 턴을 연다 · 닫힌 쪽은 재시도 안 한다', () => {
    const queue = new TaskNotificationQueue();
    const old = seatHarness({ queue });
    const fresh = seatHarness({ queue });
    old.wake.dispose();
    fresh.mount();
    queue.enqueue(pending('t1'));
    expect(fresh.opened()).toHaveLength(1);
    expect(old.opened()).toHaveLength(0);
  });
});

// ── 생산 조립 경로 — showDashboard 가 부르는 «그 함수»를 그대로 지나는 무대(문자열 확인 아님) ──────────
// 무대 이름: «agent-wake 생산 조립» (L2 mock 시나리오) — 진짜 `createInternalTurnGate`(H2 문) ⊕ 진짜
// `TaskNotificationQueue` ⊕ 진짜 `wrapAgentWakePort`(입력칸 문) ⊕ 가짜 자리 판정·가짜 시계(defer 큐).
// showDashboard 는 `installSeatedAgentWake` 하나만 부르므로, 이 무대는 생산 진입 경로를 그대로 지난다.
describe('생산 조립 — installSeatedAgentWake 를 지나 enqueue → H2 한 턴 · 중복 거부', () => {
  function stage(over: { seat?: string | null; queue?: TaskNotificationQueue } = {}) {
    const calls: Array<{ text: string; opts: StartTurnIfIdleOptions }> = [];
    const lines: string[] = [];
    const logs: LogRow[] = [];
    const clock: Array<() => void> = [];
    const state = { running: false, buffer: '' as string | undefined, yields: 0 };
    const queue = over.queue ?? new TaskNotificationQueue();
    const log = (category: string, event: string, data: Record<string, unknown>) => { logs.push({ category, event, data }); };
    const gate = createInternalTurnGate({
      isEnabled: () => true,
      isTurnRunning: () => state.running,
      getBufferText: () => state.buffer,
      getTypeaheadCount: () => 0,
      pendingKeyCount: () => 0,
      lastHumanKeyAt: () => 0,
      log,
    });
    // 생산 배선과 같은 모양: 입력칸 문은 깨움 감싸기를 거친다(index.ts `wrapAgentWakePort(...)`).
    const port = wrapAgentWakePort(gate.port);
    const mount = () => port.attach(() => { if (state.buffer) return false; state.yields++; return true; });
    const wake = installSeatedAgentWake({
      subscribe: (listener) => queue.onEnqueue(listener),
      notify: createDashboardAgentWakeNotify((line) => { lines.push(line); }, () => { /* draw */ }),
      startTurnIfIdle: (text, opts) => { calls.push({ text, opts }); return gate.startTurnIfIdle(text, opts); },
      getCwd: () => '/home/x/elanous-hq/seats/OPC',
      isPending: (taskId) => queue.has(taskId),
      detectSeat: () => (over.seat === null ? null : ({ seat: over.seat ?? 'OPC', source: 'cwd' as const })),
      defer: (fn) => { clock.push(fn); },
      log,
    });
    const flush = () => { while (clock.length) clock.shift()!(); };
    const opened = () => logs.filter(r => r.category === 'tui.autoturn' && r.event === 'opened');
    const wakeRows = (event: string) => logs.filter(r => r.category === 'tui.agent-wake' && r.event === event);
    return { queue, gate, state, mount, wake, lines, calls, logs, flush, opened, wakeRows };
  }

  test('자리 TUI ∧ 유휴: enqueue 1 → 알림 1줄 ⊕ H2 호출 1회(origin child-complete · 프롬프트 그대로)', () => {
    const s = stage();
    s.mount();
    s.queue.enqueue(pending('t1'));
    expect(s.lines).toEqual(['✓ 위임 끝: pr-review — 다음 턴에 결과']);
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.opts).toMatchObject({ origin: 'child-complete', reason: '위임 끝: pr-review' });
    expect(s.calls[0]!.text).toBe(formatAgentWakePrompt(pending('t1')));
    expect(s.opened()).toHaveLength(1);
    expect(s.gate.takePending()).toMatchObject({ origin: 'child-complete' });
    expect(s.queue.size).toBe(1);
  });

  test('같은 완료가 다시 와도(큐 clear 뒤) 생산 경로에서 두 번째 턴을 열지 않는다(duplicate)', () => {
    const queue = new TaskNotificationQueue();
    const s = stage({ queue });
    s.mount();
    queue.enqueue(pending('t1'));
    queue.clear();
    queue.enqueue(pending('t1'));
    expect(s.calls).toHaveLength(1);
    expect(s.opened()).toHaveLength(1);
    expect(s.lines).toHaveLength(1);
    expect(s.wakeRows('rejected').at(-1)!.data).toMatchObject({ taskId: 't1', reason: 'duplicate' });
  });

  test('턴 중(busy) 완료 → 즉시 턴 0 · 입력칸이 다시 뜨면 생산 경로의 재시도가 한 번 연다', () => {
    const s = stage();
    s.mount();
    s.state.running = true;
    s.queue.enqueue(pending('t1'));
    expect(s.opened()).toHaveLength(0);
    expect(s.wakeRows('deferred')[0]!.data).toMatchObject({ reason: 'NotIdle', trigger: 'enqueue' });
    s.state.running = false;
    s.mount();
    s.flush();
    expect(s.opened()).toHaveLength(1);
    expect(s.wakeRows('opened')[0]!.data).toMatchObject({ trigger: 'input-mounted' });
    s.gate.takePending(); s.mount(); s.flush();
    expect(s.opened()).toHaveLength(1);
  });

  test('사람 대화 TUI(자리 아님) → 알림만 · H2 호출 0(생산 조립에서도 판정은 모듈 몫)', () => {
    const s = stage({ seat: null });
    s.mount();
    s.queue.enqueue(pending('t1'));
    expect(s.lines).toHaveLength(1);
    expect(s.calls).toHaveLength(0);
    expect(s.wakeRows('rejected')[0]!.data).toMatchObject({ reason: 'not-seat' });
  });
});

describe('TaskNotificationQueue.has — «그» 결과가 아직 안 실렸나(재시도 근거)', () => {
  test('enqueue 뒤 true · drain 뒤 false · 다른 taskId 는 false', () => {
    const q = new TaskNotificationQueue();
    q.enqueue(pending('a'));
    expect(q.has('a')).toBe(true);
    expect(q.has('b')).toBe(false);
    q.drain();
    expect(q.has('a')).toBe(false);
  });
});
