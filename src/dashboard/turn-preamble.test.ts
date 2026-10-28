// TUI 턴 preamble — elanous 자기접근 규율 주입 계약 (P3 · 2026-07-13).
// 텔레그램(makeElanousAgentRunTurn)과 단일 출처(agent/self-ambient.ts)의 규율이 TUI 채팅
// systemPrompt 에도 실리는지 — 3박자(툴·기억·규율) 중 '규율' 축의 표면 패리티.
import { test, expect, describe, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildControllerSystemMessage, buildDashboardTurnPreamble } from './turn-preamble.js';
import { SEAT_MEMORY_RECALL_PREFIX, startSeatBootConversation } from './seat-boot-preamble.js';
import { LAST_SESSION_FILE } from './seat-local-instructions.js';
import { globalTaskNotificationQueue, type PendingTaskNotification } from '../agent/task-notification.js';
import { getUserConfig } from '../user-config.js';
import { debug } from '../debug/log.js';
import { MsgStore } from '../msg/msg-store.js';
import { createSessionPostureState, resolveSessionTurnProfile } from '../session-runtime/index.js';
import { withSimClock } from '../ux-sim/fake-clock.js';
import {
  createDashboardAgentWakeNotify,
  formatAgentWakePrompt,
  installSeatedAgentWake,
  resetAgentWakeForTest,
  wrapAgentWakePort,
} from './input/agent-wake.js';
import { createInternalTurnGate, type StartTurnIfIdleOptions } from './input/internal-turn.js';

const fakeConfig = { chat: { conciseness: 'balanced' } } as unknown as ReturnType<typeof getUserConfig>;

test('research surface carries the current date and allows a full sourced report', () => {
  const baseConfig = getUserConfig();
  const config = { ...baseConfig, chat: { ...baseConfig.chat, conciseness: {
    enabled: true, finalMessageMaxLines: 10, preambleMaxWords: 12, flatBullets: true,
  } } };
  const cwd = mkdtempSync(join(tmpdir(), 'research-preamble-'));
  try {
    const chatModeState = createSessionPostureState();
    const build = (userText: string) => buildDashboardTurnPreamble({
      userText, cwd, userConfig: config, memory: false,
      turnProfile: resolveSessionTurnProfile({ userText, chatModeState }),
    }).map((message) => String(message.content)).join('\n');
    const research = build('최신 채권 금리 상승 원인을 조사해줘');
    const ordinary = build('이 함수를 고쳐줘');
    expect(research).toContain('Current local date:');
    expect(research).not.toContain('Keep the final response to at most');
    expect(ordinary).not.toContain('Current local date:');
    expect(ordinary).toContain('Keep the final response to at most');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

describe('buildDashboardTurnPreamble — L1 자리 부트 카드(TUI-SESSION-BOOT)', () => {
  test('사람 안내 0: 새 대화 첫 턴이 자리·안 읽은 우편 수를 말한다 — /session new 도 첫 턴에 새 카드를 얻는다', () => {
    const home = mkdtempSync(join(tmpdir(), 'preamble-seatboot-'));
    const cwd = join(home, 'elanous-hq', 'seats', 'OP');
    mkdirSync(cwd, { recursive: true });
    mkdirSync(join(home, 'elanous-hq', 'seat-state', 'OP'), { recursive: true });
    writeFileSync(join(cwd, 'AGENTS.local.md'), '역할 = 판정 제안 담당\n');
    writeFileSync(join(cwd, LAST_SESSION_FILE), '## 지난 세션 (TUI 가 대화 끝마다 갈아 쓴다 · 사람이 고치지 않는 파일)\n- 마지막 요청: 세션 정리해줘\n- 열린 일: 대시보드 첫 화면 검토\n');
    writeFileSync(join(home, 'elanous-hq', 'seat-state', 'OP', 'HANDOFF-now.md'), '# OP 이어받기 — 10-22\n클래식 회상 줄 확인\n');
    const msgPath = join(home, 'state', 'msg', 'messages.db');
    const store = new MsgStore(msgPath);
    try {
      store.post({ from: 'TC', to: 'OP', body: 'zero-guidance-mail' });
      const firstTurn = buildDashboardTurnPreamble({ userText: '', cwd, userConfig: fakeConfig, seatBoot: { home, msgPath, env: {} } });
      const firstText = firstTurn.map((message) => String(message.content)).join('\n');
      expect(firstText).toContain('# OP 자리 부팅 카드');
      expect(firstText).toContain('안 읽은 msg 1 (OP)');
      expect(firstText).toContain("첫 답에서 자리 이름·'자리 역할' 절의 역할·안 읽은 우편 수");
      expect(firstText).toContain('역할: 판정 제안 담당');
      expect(firstText).toContain('## 지난 세션');
      expect(firstText).toContain('열린 일: 대시보드 첫 화면 검토');
      // TUI-SEAT-MEMORY-RECALL — 클래식 대시보드 첫 턴에도 직전 인계 회상 한 줄.
      expect(firstText.split('\n').filter((line) => line.startsWith(SEAT_MEMORY_RECALL_PREFIX))).toEqual([
        expect.stringContaining('클래식 회상 줄 확인'),
      ]);
      startSeatBootConversation({ reason: 'session-new' });
      store.post({ from: 'TC', to: 'OP', body: 'second-mail' });
      store.post({ from: 'MK', to: 'ALL', body: 'broadcast-mail' });
      const newSessionFirstTurn = buildDashboardTurnPreamble({ userText: '', cwd, userConfig: fakeConfig, seatBoot: { home, msgPath, env: {} } });
      const newText = newSessionFirstTurn.map((message) => String(message.content)).join('\n');
      expect(newText).toContain('# OP 자리 부팅 카드');
      expect(newText).toContain('안 읽은 msg 3 (OP)');
      expect(newText).toContain('역할: 판정 제안 담당');
    } finally { store.close(); rmSync(home, { recursive: true, force: true }); }
  });
});

describe('buildDashboardTurnPreamble — 제어 표면', () => {
  const build = (controlEnv?: { controller?: string; channels?: string }) => buildDashboardTurnPreamble({
    userText: 'continue',
    cwd: mkdtempSync(join(tmpdir(), 'preamble-controller-')),
    userConfig: fakeConfig,
    ...(controlEnv !== undefined ? { controlEnv } : {}),
  });

  test('builds the exact controller system-message paragraph', () => {
    expect(buildControllerSystemMessage('pty:pty_abcd1234', 'pty,inbox')).toEqual({
      role: 'system',
      content: '[제어 표면] 이 엘라누스 세션은 밖의 제어자 pty:pty_abcd1234 가 몰고 있다. 열린 관: pty,inbox. 감독 메모로 들어온 지시는 이 제어자의 지시다. PTY 로 들어오는 입력도 사람이 아니라 이 제어자가 넣은 것일 수 있다.',
    });
  });

  test('injected controller and channels produce exactly one controller system message', () => {
    const messages = build({ controller: 'pty:pty_abcd1234', channels: 'pty,inbox' });
    const controllerMessages = messages.filter((message) => message.role === 'system'
      && String(message.content).includes('[제어 표면]'));

    expect(controllerMessages).toHaveLength(1);
    expect(controllerMessages[0]?.content).toContain('pty:pty_abcd1234');
    expect(controllerMessages[0]?.content).toContain('pty,inbox');
  });

  test('injected controller defaults its channel to pty', () => {
    const messages = build({ controller: 'agent:claude-code' });
    const controllerMessage = messages.find((message) => String(message.content).includes('[제어 표면]'));

    expect(controllerMessage?.content).toContain('열린 관: pty.');
  });

  test('an explicitly empty control environment emits no controller message', () => {
    const messages = build({});

    expect(messages.some((message) => String(message.content).includes('[제어 표면]'))).toBe(false);
  });

  test('falls back to the controller environment when no control environment is injected', () => {
    const controller = process.env.ELANOUS_CONTROLLER;
    const channels = process.env.ELANOUS_CONTROL_CHANNELS;
    process.env.ELANOUS_CONTROLLER = 'harness:run-43b0457ad01bebc1';
    process.env.ELANOUS_CONTROL_CHANNELS = 'pty,inbox';
    try {
      const messages = build();
      const controllerMessage = messages.find((message) => String(message.content).includes('[제어 표면]'));

      expect(controllerMessage?.content).toContain('harness:run-43b0457ad01bebc1');
      expect(controllerMessage?.content).toContain('pty,inbox');
    } finally {
      if (controller === undefined) delete process.env.ELANOUS_CONTROLLER;
      else process.env.ELANOUS_CONTROLLER = controller;
      if (channels === undefined) delete process.env.ELANOUS_CONTROL_CHANNELS;
      else process.env.ELANOUS_CONTROL_CHANNELS = channels;
    }
  });

  test('without a controller, the preamble preserves its output', () => {
    const controller = process.env.ELANOUS_CONTROLLER;
    const channels = process.env.ELANOUS_CONTROL_CHANNELS;
    delete process.env.ELANOUS_CONTROLLER;
    delete process.env.ELANOUS_CONTROL_CHANNELS;
    try {
      expect(build()).toEqual(build({}));
    } finally {
      if (controller === undefined) delete process.env.ELANOUS_CONTROLLER;
      else process.env.ELANOUS_CONTROLLER = controller;
      if (channels === undefined) delete process.env.ELANOUS_CONTROL_CHANNELS;
      else process.env.ELANOUS_CONTROL_CHANNELS = channels;
    }
  });
});

describe('buildDashboardTurnPreamble — 자기접근 규율', () => {
  test('drains queued task notifications into one user message only once', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'preamble-'));
    globalTaskNotificationQueue.clear();
    globalTaskNotificationQueue.enqueue({
      taskId: 'task-dashboard-notification',
      agentName: 'dashboard-agent',
      state: 'done',
      output: 'background result',
      truncated: false,
      durationMs: 50,
      finishedAt: Date.now(),
    });

    const idle = buildDashboardTurnPreamble({ userText: '', cwd, userConfig: fakeConfig });
    expect(idle.some((message) => String(message.content).includes('<task-notification'))).toBe(false);
    expect(globalTaskNotificationQueue.size).toBe(1);
    const first = buildDashboardTurnPreamble({ userText: 'continue', cwd, userConfig: fakeConfig });
    const notification = first.find((message) => message.role === 'user'
      && String(message.content).includes('<task-notification'));
    expect(notification?.content).toContain('background result');

    const second = buildDashboardTurnPreamble({ userText: 'continue', cwd, userConfig: fakeConfig });
    expect(second).toHaveLength(first.length - 1);
    expect(second.some((message) => String(message.content).includes('<task-notification'))).toBe(false);
    globalTaskNotificationQueue.clear();
  });

  test('자동 완료 턴에는 원문 task id와 결과의 로그·PR 포인터를 함께 보존한다', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'preamble-completion-pointers-'));
    globalTaskNotificationQueue.clear();
    globalTaskNotificationQueue.enqueue({
      taskId: 'message-source-1042', agentName: 'dashboard-agent', state: 'done',
      output: '완료 · log=https://logs.example/run-1042 · PR=https://github.com/example/repo/pull/31877',
      truncated: false, durationMs: 50, finishedAt: Date.now(),
    });
    try {
      const turn = buildDashboardTurnPreamble({
        userText: '[자동 재개] 위임 끝: dashboard-agent (done) — <task-notification> 의 결과를 읽고 이어서 처리',
        cwd, userConfig: fakeConfig,
      });
      const notification = turn.find((message) => message.role === 'user'
        && String(message.content).includes('<task-notification'));
      expect(notification?.content).toContain('id="message-source-1042"');
      expect(notification?.content).toContain('https://logs.example/run-1042');
      expect(notification?.content).toContain('https://github.com/example/repo/pull/31877');
      expect(globalTaskNotificationQueue.size).toBe(0);
    } finally {
      globalTaskNotificationQueue.clear();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('알림 자동 재개는 비요청 status receipt로 한 번 요약하고, 사용자 요청이 있으면 기존 흐름을 보존한다', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'preamble-notify-receipt-'));
    const events: Array<{ category: string; event: string; data?: unknown }> = [];
    const spy = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: unknown) => {
      if (category === 'tui.notify') events.push({ category, event, data });
    }) as typeof debug.log);
    const enqueue = (taskId: string) => globalTaskNotificationQueue.enqueue({
      taskId, agentName: 'receipt-child', state: 'done', output: `result-${taskId}`,
      truncated: false, durationMs: 20, finishedAt: Date.now(),
    });
    try {
      globalTaskNotificationQueue.clear();
      enqueue('notify-only');
      const receiptTurn = buildDashboardTurnPreamble({
        userText: '[자동 재개] 위임 끝: receipt-child (done) — <task-notification> 의 결과를 읽고 이어서 처리',
        cwd, userConfig: fakeConfig,
      });
      const receiptText = receiptTurn.map(message => String(message.content)).join('\n');
      expect(receiptText).toContain('<task-notification kind="status-receipt" request="none">');
      expect(receiptTurn.filter(message => message.role === 'system'
        && String(message.content).includes('[알림 전용 턴]'))).toHaveLength(1);
      expect(receiptText).toContain('Agent 또는 SelfImplement 위임을 시작하지 않는다');
      expect(receiptText).toContain('한 번의 간결한 상태 요약만 답하고 멈춘다');
      expect(events).toHaveLength(1);
      expect(events[0]?.event).toBe('notification-only-turn');

      globalTaskNotificationQueue.clear();
      enqueue('notify-with-request');
      const requestedTurn = buildDashboardTurnPreamble({
        userText: '이 결과를 참고해 다음 작업을 구현해줘', cwd, userConfig: fakeConfig,
      });
      const requestedText = requestedTurn.map(message => String(message.content)).join('\n');
      expect(requestedText).toContain('<task-notification>');
      expect(requestedTurn.some(message => String(message.content).includes('[알림 전용 턴]'))).toBe(false);
      expect(events).toHaveLength(2);
      expect(events[1]?.event).toBe('notification-with-user-request');

      const productionShapeWake = buildDashboardTurnPreamble({
        userText: 'Context:\nDashboard mode: browse\n\nQuestion: [자동 재개] 위임 끝: receipt-child (done) — <task-notification> 의 결과를 읽고 이어서 처리',
        cwd, userConfig: fakeConfig,
      });
      expect(productionShapeWake.some(message => message.role === 'system'
        && String(message.content).includes('[알림 전용 턴]'))).toBe(true);
    } finally {
      globalTaskNotificationQueue.clear();
      spy.mockRestore();
    }
  });

  test('preamble 에 [elanous 자기접근 규율] system 메시지가 포함된다', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'preamble-'));
    const msgs = buildDashboardTurnPreamble({ userText: 'P2 왜 실패했어?', cwd, userConfig: fakeConfig });
    const hasDiscipline = msgs.some((m) => m.role === 'system'
      && typeof m.content === 'string' && m.content.includes('[elanous 자기접근 규율]'));
    expect(hasDiscipline).toBe(true);
    // 규율이 ops_status 사용을 지시하는지(진단 디시플린) — 문구 계약.
    const discipline = msgs.find((m) => typeof m.content === 'string' && m.content.includes('[elanous 자기접근 규율]'));
    expect(String(discipline!.content)).toContain('ops_status');
  });

  test('includes self-awareness capabilities and only the current turn session ID', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'preamble-'));
    const first = buildDashboardTurnPreamble({
      userText: 'inspect the current turn', cwd, userConfig: fakeConfig, sessionId: 'dashboard-first',
    });
    const second = buildDashboardTurnPreamble({
      userText: 'inspect the next turn', cwd, userConfig: fakeConfig, sessionId: 'dashboard-second',
    });
    const firstText = first.map((message) => String(message.content)).join('\n');
    const secondText = second.map((message) => String(message.content)).join('\n');
    for (const text of [firstText, secondText]) {
      expect(text).toContain('logs_query');
      expect(text).toContain('debug.log');
      expect(text).toContain('elanous self implement');
      expect(text).toContain('harness run');
      expect(text).toContain('auto-review');
    }
    expect(firstText).toContain('현재 요청의 session ID: dashboard-first');
    expect(firstText).not.toContain('dashboard-second');
    expect(secondText).toContain('현재 요청의 session ID: dashboard-second');
    expect(secondText).not.toContain('dashboard-first');
  });
});

// ── tools.nativeStructure.providers 배선 (2026-08-18) ────────────────────────
//
// ⛔ 왜 이 테스트가 있나 — `isNativeStructureEnabledForProvider` 가 «소비처 0» 이면
//   그 설정은 실행 경로에 없다(리뷰 must-fix). 이 테스트가 그 배선을 «증명»한다.
//   ⭐ preamble 산출을 «비교»하는 방식이라, 배선을 빼면 두 산출이 같아져 실패한다.
describe('buildDashboardTurnPreamble — nativeStructure providers 배선', () => {
  const cfgWith = (nativeStructure: unknown, provider: string) => ({
    chat: { conciseness: 'balanced' },
    llm: { provider },
    tools: { nativeStructure },
  } as unknown as ReturnType<typeof getUserConfig>);

  // ⛔ 목록에 «든» provider 와 «안 든» provider 로 같은 턴을 만들어 산출을 대조한다.
  //   배선이 없으면 둘 다 「켜짐」이 되어 산출이 같아진다.
  test('providers 목록에 없는 provider 는 켜지지 않는다 (목록에 있으면 켜진다)', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'preamble-ns-'));
    const args = { userText: '이 기능을 구현해줘', cwd, enabledTools: ['Read', 'Grep', 'Edit', 'PersistentGrounding'] };

    const listed = buildDashboardTurnPreamble({
      ...args, userConfig: cfgWith({ enabled: true, providers: ['grok'] }, 'grok'),
    }).map(m => String(m.content)).join('\n');
    const unlisted = buildDashboardTurnPreamble({
      ...args, userConfig: cfgWith({ enabled: true, providers: ['grok'] }, 'openai-codex'),
    }).map(m => String(m.content)).join('\n');

    expect(listed).not.toBe(unlisted);
  });

  test('목록이 없으면 종전대로 전 provider 에 적용된다 (하위 호환)', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'preamble-ns-'));
    const args = { userText: '이 기능을 구현해줘', cwd, enabledTools: ['Read', 'Grep', 'Edit', 'PersistentGrounding'] };

    const a = buildDashboardTurnPreamble({
      ...args, userConfig: cfgWith({ enabled: true }, 'grok'),
    }).map(m => String(m.content)).join('\n');
    const b = buildDashboardTurnPreamble({
      ...args, userConfig: cfgWith({ enabled: true }, 'openai-codex'),
    }).map(m => String(m.content)).join('\n');

    expect(a).toBe(b);
  });

  test('꺼져 있으면 목록이 무엇이든 아무 provider 에도 적용되지 않는다', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'preamble-ns-'));
    const args = { userText: '이 기능을 구현해줘', cwd, enabledTools: ['Read', 'Grep', 'Edit', 'PersistentGrounding'] };

    const off = buildDashboardTurnPreamble({
      ...args, userConfig: cfgWith({ enabled: false, providers: ['grok'] }, 'grok'),
    }).map(m => String(m.content)).join('\n');
    const noConfig = buildDashboardTurnPreamble({
      ...args, userConfig: cfgWith(undefined, 'grok'),
    }).map(m => String(m.content)).join('\n');

    expect(off).toBe(noConfig);
  });
});

// TURN-START-BLOCK-REST 1단계 — `chat.turn-preamble built` 이 «어느 빌더가 얼마나 막았나»를 싣는다.
//   ⭐ 반증: 측정(`timed`)을 빼면 `builderMs` 가 없거나 키가 빠져 실패한다.
describe('buildDashboardTurnPreamble — 빌더별 ms 관측', () => {
  const capture = (build: () => unknown): Record<string, unknown>[] => {
    const events: Record<string, unknown>[] = [];
    const wasEnabled = debug.enabled;
    if (!wasEnabled) debug.setDiagEnabled(true);
    const spy = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data: Record<string, unknown>) => {
      if (category === 'chat.turn-preamble' && event === 'built') events.push(data);
    }) as typeof debug.log);
    try { build(); } finally {
      spy.mockRestore();
      if (!wasEnabled) debug.setDiagEnabled(false);
    }
    return events;
  };

  test('불린 빌더마다 ms 가 실리고, 동기 표지와 합계가 같이 실린다', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'preamble-ms-'));
    const config = getUserConfig();
    const chatModeState = createSessionPostureState();
    const [data] = capture(() => buildDashboardTurnPreamble({
      userText: '이 기능을 구현해줘',
      cwd,
      userConfig: { ...config, llm: { ...config.llm, provider: 'grok' }, tools: { ...config.tools, nativeStructure: { enabled: true } } },
      turnProfile: resolveSessionTurnProfile({ userText: '이 기능을 구현해줘', chatModeState }),
      enabledTools: ['Read', 'Edit'],
      seatBoot: { home: cwd, msgPath: join(cwd, 'msg.db'), env: {} },
      memory: { root: join(cwd, 'memory'), env: {} },
      controlEnv: { controller: 'pty:pty_abcd1234' },
    }));

    expect(data).toBeDefined();
    const builderMs = data!.builderMs as Record<string, number>;
    expect(Object.keys(builderMs).sort()).toEqual([
      ...Object.keys(data!.builderCounts as Record<string, number>),
      'nativeTools',
      'taskNotifications',
    ].sort());
    for (const ms of Object.values(builderMs)) {
      expect(typeof ms).toBe('number');
      expect(ms).toBeGreaterThanOrEqual(0);
    }
    expect(data!.builderMsKind).toBe('sync');
    expect(data!.builderTotalMs as number).toBeGreaterThanOrEqual(0);
  });

  test('조건부 빌더는 안 불리면 키가 없다 — 0 으로 꾸미지 않는다', () => {
    const [data] = capture(() => buildDashboardTurnPreamble({
      userText: 'continue',
      cwd: mkdtempSync(join(tmpdir(), 'preamble-ms-')),
      userConfig: fakeConfig,
      memory: false,
      controlEnv: {},
    }));

    expect(Object.keys(data!.builderMs as Record<string, number>).sort()).toEqual([
      'approval', 'ask', 'conciseness', 'gitSnapshot', 'implDiscipline', 'planMode',
      'sandbox', 'selfHealth', 'selfOps', 'taskNotifications', 'universal',
    ]);
  });

  test('debug 가 꺼진 턴은 built 를 안 낸다(재지도 않는다)', () => {
    if (debug.enabled) return;
    const events: unknown[] = [];
    const spy = spyOn(debug, 'log').mockImplementation(((category: string) => {
      if (category === 'chat.turn-preamble') events.push(category);
    }) as typeof debug.log);
    try {
      buildDashboardTurnPreamble({ userText: 'x', cwd: mkdtempSync(join(tmpdir(), 'preamble-ms-')), userConfig: fakeConfig });
    } finally { spy.mockRestore(); }
    expect(events).toEqual([]);
  });
});

// TUI-SELF-HEALTH-LINE(0.2.34) — 매 턴 자기 건강 한 줄 배선. 오류 주입 → 다음 턴 프리앰블 문면이
//   그 오류를 말하는지 · 낡은 판 상황 → 재기동 필요 문면(stale-install-check 재료 재사용)이 나오는지를
//   프리앰블 산출로 본다. 판정 seam 없이는 시험 격리가 안 되므로 ctx.selfHealth 로 판정 재료를 주입한다.
describe('buildDashboardTurnPreamble — 매 턴 자기 건강 한 줄(TUI-SELF-HEALTH-LINE)', () => {
  const SHA_A = 'a'.repeat(40);
  const SHA_B = 'b'.repeat(40);
  const installedBuild = () => ({ version: '0.2.34', sha: SHA_A, source: 'installed' as const, codeRoot: '/r' });
  const textOf = (msgs: ReturnType<typeof buildDashboardTurnPreamble>) => msgs.map((m) => String(m.content)).join('\n');

  test('오류 주입 뒤 다음 턴 프리앰블 문면이 그 오류를 말한다 — 집계가 없으면 오류 축은 말하지 않는다', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'preamble-health-'));
    const withErrors = buildDashboardTurnPreamble({
      userText: 'continue', cwd, userConfig: fakeConfig,
      selfHealth: {
        errors: { count: 2, sample: 'llm.response 502 (grok)' },
        build: installedBuild, readInstalled: () => ({ sha: SHA_A }),
      },
    });
    const text = textOf(withErrors);
    expect(text).toContain('[자기 건강]');
    expect(text).toContain('직전 30분 자기 오류 2건');
    expect(text).toContain('대표: llm.response 502 (grok)');
    expect(withErrors.filter((m) => m.role === 'system' && String(m.content).includes('[자기 건강]'))).toHaveLength(1);

    const zeroErrors = buildDashboardTurnPreamble({
      userText: 'continue', cwd, userConfig: fakeConfig,
      selfHealth: { errors: { count: 0 }, build: installedBuild, readInstalled: () => ({ sha: SHA_A }) },
    });
    expect(textOf(zeroErrors)).toContain('직전 30분 자기 오류 0건');

    // 오류 집계 계약(«어떤 이벤트를 오류로 세는지»)은 미결 — 집계가 없으면 그 축을 지어내지 않는다.
    const withoutAggregate = buildDashboardTurnPreamble({
      userText: 'continue', cwd, userConfig: fakeConfig,
      selfHealth: { build: installedBuild, readInstalled: () => ({ sha: SHA_A }) },
    });
    expect(textOf(withoutAggregate)).not.toContain('자기 오류');
  });

  test('낡은 판이면 재기동 필요 문면이 나온다 — stale-install-check 안내·명령 문면을 그대로 쓴다', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'preamble-health-'));
    const stale = buildDashboardTurnPreamble({
      userText: 'continue', cwd, userConfig: fakeConfig, sessionId: 'sess-relaunch',
      selfHealth: { build: installedBuild, readInstalled: () => ({ sha: SHA_B, installedAt: 200 }) },
    });
    const staleText = textOf(stale);
    expect(staleText).toContain('낡은 판 — 재기동 필요');
    expect(staleText).toContain('새 판이 깔렸습니다');
    expect(staleText).toContain(`부팅 판 ${SHA_A.slice(0, 7)} → 지금 ${SHA_B.slice(0, 7)}`);
    expect(staleText).toContain('TUI 를 다시 띄우면 새 판으로 돕니다');
    expect(staleText).toContain('다시 띄우기: elanous --resume "sess-relaunch"');

    const fresh = buildDashboardTurnPreamble({
      userText: 'continue', cwd, userConfig: fakeConfig,
      selfHealth: { build: installedBuild, readInstalled: () => ({ sha: SHA_A }) },
    });
    expect(textOf(fresh)).toContain('판 최신(same-as-installed)');
    expect(textOf(fresh)).not.toContain('재기동 필요');
  });

  test('판정 재료가 깨져도 프리앰블은 산다(fail-soft) · 크레딧 축은 주어진 것만 실린다', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'preamble-health-'));
    const broken = buildDashboardTurnPreamble({
      userText: 'continue', cwd, userConfig: fakeConfig,
      selfHealth: { build: () => { throw new Error('boom'); } },
    });
    expect(broken.some((m) => String(m.content).includes('[자기 건강]'))).toBe(false);
    expect(broken.length).toBeGreaterThan(0);

    const credited = buildDashboardTurnPreamble({
      userText: 'continue', cwd, userConfig: fakeConfig,
      selfHealth: { creditUsage: '1.2M tokens', build: installedBuild, readInstalled: () => ({ sha: SHA_A }) },
    });
    expect(textOf(credited)).toContain('크레딧 사용 1.2M tokens');
  });

  test('자기 건강 칸 관측 — 매 턴 timed() 에 selfHealth ms·count 가 실린다', () => {
    const events: Record<string, unknown>[] = [];
    const wasEnabled = debug.enabled;
    if (!wasEnabled) debug.setDiagEnabled(true);
    const spy = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data: Record<string, unknown>) => {
      if (category === 'chat.turn-preamble' && event === 'built') events.push(data);
    }) as typeof debug.log);
    try {
      buildDashboardTurnPreamble({
        userText: 'continue', cwd: mkdtempSync(join(tmpdir(), 'preamble-health-')), userConfig: fakeConfig,
        selfHealth: { errors: { count: 1 }, build: installedBuild, readInstalled: () => ({ sha: SHA_A }) },
      });
    } finally {
      spy.mockRestore();
      if (!wasEnabled) debug.setDiagEnabled(false);
    }
    const [data] = events;
    expect(data).toBeDefined();
    expect((data!.builderMs as Record<string, number>).selfHealth).toBeGreaterThanOrEqual(0);
    expect((data!.builderCounts as Record<string, number>).selfHealth).toBe(1);
  });
});

// ── TUI-EVENT-TURN-QUEUE — 완료 경계 실물 무대 (fake clock ⊕ 생산 조립) ─────────────────────
//
// 완료 경계(부모 칸 TUI-EVENT-TURN-QUEUE 에서 물려받은 3행):
//   완료 통지가 idle 동안 들어오면 턴 하나만 열고 같은 완료 중복 신호는 턴을 추가하지 않는다.
//   응답 active 중 신호는 다음 턴까지 큐에 둔다. 입력창 변형·inbox.md·정시 프롬프트는 범위 밖이다.
//
// 무대(L2 · fake clock): src/ux-sim/fake-clock.ts 의 withSimClock 이 생산 기본 defer
// (`setTimeout(fn, 0)` — agent-wake.ts 가 defers 재시도에 쓰는 것)를 돌린다. 나머지는 전부 실물:
//   • 실제 큐 globalTaskNotificationQueue ⊕ 실제 dashboard 구독 subscribeDashboardAgentResults
//     — showDashboard 조립부가 installSeatedAgentWake 에 넘기는 것(src/dashboard/index.ts)
//   • 생산 조립 installSeatedAgentWake(showDashboard 가 부르는 그 함수 하나)
//   • 실제 H2 문 createInternalTurnGate ⊕ 실제 입력칸 문 감싸기 wrapAgentWakePort
//   • 실제 자리 판정 detectSeatTui(home 픽스처 — 생산은 detectSeat 을 안 넘긴다)
//   • 실제 턴 프리앰블 buildDashboardTurnPreamble(깨움 턴 진입의 <task-notification> drain)
// 생산 호출자(배선 증거): src/dashboard/index.ts — subscribeDashboardAgentResults(정의 ~1319) ·
//   wrapAgentWakePort(~3601) · installSeatedAgentWake(~13497) · consumeInternalTurnYield(~17232)
//   · buildDashboardTurnPreamble(getPreamble 단일 출처 — turn-preamble.ts).
// 첫 화면 콜백 회귀: 부팅(첫 화면) 때 프리앰블 getter 는 userText 없이 불린다(turn-preamble.ts
//   Phase 5a 주석 ⊕ «ACP may ask for a preamble while the session is idle») — 그 콜백이 완료
//   영수증을 큐에서 꺼내 먹으면 안 된다(다음 실제 턴까지 보존).
describe('TUI-EVENT-TURN-QUEUE — 완료 경계 실물(fake clock ⊕ 생산 조립)', () => {
  /** 자리 TUI 판정이 통과하는 home 픽스처(이 파일의 TUI-SESSION-BOOT 시험과 같은 모양). */
  function makeSeatHome(): { home: string; seatCwd: string } {
    const home = mkdtempSync(join(tmpdir(), 'turn-queue-seat-'));
    const seatCwd = join(home, 'elanous-hq', 'seats', 'OP');
    mkdirSync(seatCwd, { recursive: true });
    mkdirSync(join(home, 'elanous-hq', 'seat-state', 'OP'), { recursive: true });
    writeFileSync(join(seatCwd, 'AGENTS.local.md'), '역할 = 완료 경계 시험 자리\n');
    writeFileSync(join(seatCwd, LAST_SESSION_FILE), '## 지난 세션 (시험 픽스처)\n- 마지막 요청: 완료 경계 시험\n');
    return { home, seatCwd };
  }

  function completion(taskId: string, output: string, finishedAt: number): PendingTaskNotification {
    return {
      taskId,
      agentName: 'general-purpose',
      label: 'pr-review',
      state: 'done',
      output,
      truncated: false,
      durationMs: 1200,
      finishedAt,
    };
  }

  /** 실물 무대: 실제 큐·구독·생산 조립·H2 문·입력칸 감싸기. 시계만 fake-clock 몫이다. */
  async function seatStage(home: string, seatCwd: string) {
    const logs: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    const lines: string[] = [];
    const historyLines: string[] = [];
    const h2Calls: Array<{ text: string; opts: StartTurnIfIdleOptions }> = [];
    const state = { running: false, buffer: '' as string | undefined, yields: 0 };
    const log = (category: string, event: string, data: Record<string, unknown>) => {
      logs.push({ category, event, data });
    };
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
    const mount = () => port.attach(() => { if (state.buffer) return false; state.yields += 1; return true; });
    const { subscribeDashboardAgentResults } = await import('./index.js');
    const wake = installSeatedAgentWake({
      subscribe: (listener) => subscribeDashboardAgentResults(globalTaskNotificationQueue, listener, (line) => { historyLines.push(line); }),
      notify: createDashboardAgentWakeNotify((line) => { lines.push(line); }, () => { /* draw */ }),
      startTurnIfIdle: (text, opts) => { h2Calls.push({ text, opts }); return gate.startTurnIfIdle(text, opts); },
      getCwd: () => seatCwd,
      isPending: (taskId) => globalTaskNotificationQueue.has(taskId),
      home,
      log,
    });
    const opened = () => logs.filter((row) => row.category === 'tui.autoturn' && row.event === 'opened');
    return { gate, mount, lines, historyLines, h2Calls, logs, state, wake, opened };
  }

  test('TUI-EVENT-TURN-QUEUE: acceptance 1완료 경계 코드: 완료 통지가 idle 동안 들어오면 턴 하나만 열고 같은 완료 중복 신호는 턴을 추가하지 않는다', async () => {
    resetAgentWakeForTest();
    globalTaskNotificationQueue.clear();
    const { home, seatCwd } = makeSeatHome();
    try {
      const stage = await seatStage(home, seatCwd);
      await withSimClock(Date.UTC(2026, 9, 27, 8, 0, 0), async (clock) => {
        stage.mount();
        const notice = completion('turn-queue-idle-a1', 'idle 결과', clock.now());
        globalTaskNotificationQueue.enqueue(notice);
        // 완료 1건 → idle 턴 정확히 1개(origin child-complete · 깨움 프롬프트 그대로 · 입력칸 무접촉).
        expect(stage.opened()).toHaveLength(1);
        expect(stage.opened()[0]!.data).toMatchObject({ origin: 'child-complete' });
        expect(stage.lines).toEqual(['✓ 위임 끝: pr-review — 다음 턴에 결과']);
        const request = stage.gate.takePending();
        expect(request).toMatchObject({ origin: 'child-complete', input: formatAgentWakePrompt(notice) });
        expect(stage.state.buffer).toBe('');
        expect(stage.state.yields).toBe(1);
        // 같은 완료 중복 신호 ① — 큐 `seen` 이 막는다: 깨움 리스너조차 다시 안 불린다.
        const logCount = stage.logs.length;
        globalTaskNotificationQueue.enqueue(notice);
        expect(stage.logs.length).toBe(logCount);
        // 같은 완료 중복 신호 ② — 큐 clear 뒤 재신호: 깨움 `handled` 집합이 'duplicate' 로 거부한다.
        globalTaskNotificationQueue.clear();
        globalTaskNotificationQueue.enqueue(notice);
        expect(stage.opened()).toHaveLength(1);
        expect(stage.h2Calls).toHaveLength(1);
        expect(stage.logs.at(-1)).toMatchObject({
          category: 'tui.agent-wake',
          event: 'rejected',
          data: { taskId: 'turn-queue-idle-a1', reason: 'duplicate' },
        });
      });
    } finally {
      resetAgentWakeForTest();
      globalTaskNotificationQueue.clear();
      rmSync(home, { recursive: true, force: true });
    }
  }, 120_000);

  test('TUI-EVENT-TURN-QUEUE: 완료 경계 실물: 응답 active 중 도착한 신호는 다음 턴까지 큐에 둔다 — fake clock 이 생산 defer(setTimeout 0) 재시도를 돌려 다음 턴 1개', async () => {
    resetAgentWakeForTest();
    globalTaskNotificationQueue.clear();
    const { home, seatCwd } = makeSeatHome();
    try {
      const stage = await seatStage(home, seatCwd);
      await withSimClock(Date.UTC(2026, 9, 27, 8, 0, 0), async (clock) => {
        stage.mount();
        stage.state.running = true; // 응답 active — 완료가 도착한다
        const notice = completion('turn-queue-active-a1', 'active 중 도착 결과', clock.now());
        globalTaskNotificationQueue.enqueue(notice);
        expect(stage.opened()).toHaveLength(0); // 그 순간 턴 0
        expect(globalTaskNotificationQueue.has('turn-queue-active-a1')).toBe(true); // 큐에 그대로
        const deferredRow = stage.logs.find((row) => row.category === 'tui.agent-wake' && row.event === 'deferred');
        expect(deferredRow?.data).toMatchObject({ taskId: 'turn-queue-active-a1', reason: 'NotIdle', trigger: 'enqueue' });
        // 턴이 끝나 입력칸이 다시 뜬다 — 재시도는 생산 기본 defer(setTimeout 0) 로 미뤄진다.
        stage.state.running = false;
        stage.mount();
        expect(stage.opened()).toHaveLength(0); // 아직 예약일 뿐
        expect(clock.pendingTimers()).toBe(1);
        clock.tick(0); // fake clock 이 생산 defer 를 돌린다
        expect(stage.opened()).toHaveLength(1); // 다음 턴 정확히 1개
        expect(stage.opened()[0]!.data).toMatchObject({ origin: 'child-complete' });
        const wakeOpened = stage.logs.find((row) => row.category === 'tui.agent-wake' && row.event === 'opened');
        expect(wakeOpened?.data).toMatchObject({ taskId: 'turn-queue-active-a1', trigger: 'input-mounted' });
        const request = stage.gate.takePending();
        expect(request?.origin).toBe('child-complete');
        // 재시도는 한 번 — 다시 떠도 시계를 돌려도 추가 턴은 없다.
        stage.mount();
        clock.tick(0);
        expect(stage.opened()).toHaveLength(1);
      });
    } finally {
      resetAgentWakeForTest();
      globalTaskNotificationQueue.clear();
      rmSync(home, { recursive: true, force: true });
    }
  }, 120_000);

  test('TUI-EVENT-TURN-QUEUE: 완료 경계 실물: 첫 화면 콜백 회귀 — 부팅 프리앰블 콜백은 큐를 안 먹고 깨움 턴 프리앰블이 정확히 한 번 실는다', async () => {
    resetAgentWakeForTest();
    globalTaskNotificationQueue.clear();
    const { home, seatCwd } = makeSeatHome();
    const cwd = mkdtempSync(join(tmpdir(), 'turn-queue-preamble-'));
    try {
      const stage = await seatStage(home, seatCwd);
      await withSimClock(Date.UTC(2026, 9, 27, 8, 0, 0), async (clock) => {
        stage.mount();
        const unique = `turn-queue-first-screen-${Math.random()}`;
        const notice = completion('turn-queue-first-screen-a1', unique, clock.now());
        globalTaskNotificationQueue.enqueue(notice);
        expect(stage.opened()).toHaveLength(1);
        // 첫 화면(부팅) 콜백 — userText 없이 프리앰블 getter 가 불릴 때: 영수증은 큐에 그대로(회귀 확인).
        const firstScreen = buildDashboardTurnPreamble({ userText: '', cwd, userConfig: fakeConfig });
        expect(firstScreen.some((m) => String(m.content).includes('<task-notification'))).toBe(false);
        expect(globalTaskNotificationQueue.size).toBe(1);
        // 깨움 턴 진입 — 실제 턴 프리앰블이 영수증을 정확히 한 번 싣는다(알림 전용 status receipt).
        const request = stage.gate.takePending();
        expect(request?.origin).toBe('child-complete');
        const turnPreamble = buildDashboardTurnPreamble({ userText: request!.input, cwd, userConfig: fakeConfig });
        const carried = turnPreamble.filter((m) => m.role === 'user' && String(m.content).includes('<task-notification'));
        expect(carried).toHaveLength(1);
        expect(String(carried[0]!.content)).toContain('<task-notification kind="status-receipt" request="none">');
        expect(String(carried[0]!.content)).toContain('id="turn-queue-first-screen-a1"');
        expect(String(carried[0]!.content)).toContain(unique);
        expect(turnPreamble.filter((m) => m.role === 'system' && String(m.content).includes('[알림 전용 턴]'))).toHaveLength(1);
        expect(globalTaskNotificationQueue.size).toBe(0);
        // 다음 턴은 더 싣지 않는다.
        const nextTurn = buildDashboardTurnPreamble({ userText: '이 결과를 보고 다음 작업을 정해줘', cwd, userConfig: fakeConfig });
        expect(nextTurn.some((m) => String(m.content).includes('<task-notification'))).toBe(false);
      });
    } finally {
      resetAgentWakeForTest();
      globalTaskNotificationQueue.clear();
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 120_000);
});
