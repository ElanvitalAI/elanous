import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DaemonSessionHistory } from '../boot/daemon-runtime.js';
import { abortAgentTurn, createAgentTurnRunner } from './agent-turn.js';
import { buildReplSystemPrompt } from './index.js';
import { resetSeatBootCacheForTest } from '../dashboard/seat-boot-preamble.js';
import { MsgStore } from '../msg/msg-store.js';
import type { UserConfig } from '../user-config.js';
import { debug } from '../debug/log.js';

const context = {
  bufferText: '',
  cwd: '/tmp/repo',
  cols: 80,
  rows: 24,
  bufferLines: 0,
};

function createDeps(overrides: Record<string, unknown> = {}) {
  return {
    history: new DaemonSessionHistory(),
    collectContext: () => context,
    ...overrides,
  };
}

describe('REPL agent goal-loop selection', () => {
  test('omitted selection preserves the legacy single-turn result shape', async () => {
    let legacyCalls = 0;
    let goalLoopCalls = 0;
    const runner = createAgentTurnRunner(createDeps({
      runner: async (opts: { request: { sessionId: string } }) => {
        legacyCalls += 1;
        return { sessionId: opts.request.sessionId, text: 'single', stopReason: 'end_turn' };
      },
      goalLoopRunner: async () => {
        goalLoopCalls += 1;
        return { finalText: 'loop', stopReason: 'goal_complete', iterations: 1, goalComplete: true };
      },
    }) as never);

    const result = await runner({ sessionId: 'single-session', terminalId: 'single-terminal', prompt: 'inspect' });

    expect(legacyCalls).toBe(1);
    expect(goalLoopCalls).toBe(0);
    expect(result).toMatchObject({ markdown: 'single', stopReason: 'end_turn' });
    expect('goalLoop' in result).toBe(false);
  });

  test('disabled selection keeps the legacy result shape', async () => {
    let legacyCalls = 0;
    let goalLoopCalls = 0;
    const runner = createAgentTurnRunner(createDeps({
      runner: async (opts: { request: { sessionId: string } }) => {
        legacyCalls += 1;
        return { sessionId: opts.request.sessionId, text: 'single', stopReason: 'end_turn' };
      },
      goalLoopRunner: async () => {
        goalLoopCalls += 1;
        return { finalText: 'loop', stopReason: 'goal_complete', iterations: 1, goalComplete: true };
      },
    }) as never);

    const result = await runner({
      sessionId: 'disabled-session', terminalId: 'disabled-terminal', prompt: 'inspect', goalLoop: false,
    });

    expect(legacyCalls).toBe(1);
    expect(goalLoopCalls).toBe(0);
    expect('goalLoop' in result).toBe(false);
  });

  test('enabled selection invokes the canonical engine and exposes the selected route', async () => {
    let legacyCalls = 0;
    let received: { sessionId: string; userText?: string; signal: AbortSignal } | undefined;
    const runner = createAgentTurnRunner(createDeps({
      runner: async () => {
        legacyCalls += 1;
        throw new Error('legacy runner must not run');
      },
      goalLoopRunner: async (turn: { sessionId: string; userText?: string; signal: AbortSignal }) => {
        received = turn;
        return { finalText: 'loop', stopReason: 'goal_complete', iterations: 1, goalComplete: true };
      },
    }) as never);

    const result = await runner({
      sessionId: 'loop-session', terminalId: 'loop-terminal', prompt: 'inspect', goalLoop: true,
    });

    expect(legacyCalls).toBe(0);
    expect(received).toMatchObject({ sessionId: 'loop-session' });
    expect(received?.userText).toContain('inspect');
    expect(result).toMatchObject({ markdown: 'loop', stopReason: 'goal_complete', goalLoop: true });
  });

  test('uses the terminal coordinate for webterm context and tool dispatch while retaining chat history', async () => {
    let receivedMessages: unknown[] = [];
    let dispatchedSessionId: string | undefined;
    const runner = createAgentTurnRunner(createDeps({
      toolCwd: '/tmp/repo',
      toolSurface: {
        kind: 'webterm',
        specs: [{ name: 'WebTerminalSnapshot', description: 'snapshot', parameters: { type: 'object' } }],
        dispatch: async (_name: string, _args: Record<string, unknown>, dispatchContext: { sessionId?: string }) => {
          dispatchedSessionId = dispatchContext.sessionId;
          return 'snapshot';
        },
      },
      goalLoopRunner: async (turn: { messages: unknown[]; dispatchTool: (name: string, args: Record<string, unknown>) => Promise<unknown> }) => {
        receivedMessages = turn.messages;
        await turn.dispatchTool('WebTerminalSnapshot', {});
        return { finalText: 'loop', stopReason: 'goal_complete', iterations: 1, goalComplete: true };
      },
    }) as never);

    await runner({
      sessionId: 'chat-session', terminalId: 'webterm-terminal', prompt: 'inspect', goalLoop: true,
    });

    expect(JSON.stringify(receivedMessages)).toContain('Current ACP sessionId: webterm-terminal');
    expect(JSON.stringify(receivedMessages)).not.toContain('Current ACP sessionId: chat-session');
    expect(dispatchedSessionId).toBe('webterm-terminal');
  });

  test('forwards an explicit iteration cap only to the canonical engine', async () => {
    let receivedOptions: Record<string, unknown> | undefined;
    const runner = createAgentTurnRunner(createDeps({
      goalLoopRunner: async (_turn: unknown, options: Record<string, unknown>) => {
        receivedOptions = options;
        return { finalText: 'loop', stopReason: 'max_iterations', iterations: 1, goalComplete: false };
      },
    }) as never);

    await runner({ sessionId: 'cap-session', terminalId: 'cap-terminal', prompt: 'inspect', goalLoop: true, goalLoopMaxIterations: 1 });

    expect(receivedOptions).toEqual({ maxIterations: 1 });
  });

  test('omits iteration cap so the canonical engine retains its default', async () => {
    let receivedOptions: Record<string, unknown> | undefined;
    const runner = createAgentTurnRunner(createDeps({
      goalLoopRunner: async (_turn: unknown, options: Record<string, unknown>) => {
        receivedOptions = options;
        return { finalText: 'loop', stopReason: 'end_turn', iterations: 1, goalComplete: false };
      },
    }) as never);

    await runner({ sessionId: 'default-cap-session', terminalId: 'default-cap-terminal', prompt: 'inspect', goalLoop: true });

    expect(receivedOptions).toEqual({});
  });

  test('propagates canonical-engine errors', async () => {
    const runner = createAgentTurnRunner(createDeps({
      goalLoopRunner: async () => {
        throw new Error('goal loop failed');
      },
    }) as never);

    await expect(runner({ sessionId: 'error-session', terminalId: 'error-terminal', prompt: 'inspect', goalLoop: true }))
      .rejects.toThrow('goal loop failed');
  });

  test('threads the active-turn abort signal into the canonical engine', async () => {
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
    let resolveAborted!: () => void;
    const aborted = new Promise<void>((resolve) => { resolveAborted = resolve; });
    const runner = createAgentTurnRunner(createDeps({
      goalLoopRunner: async (turn: { signal: AbortSignal }) => {
        turn.signal.addEventListener('abort', resolveAborted, { once: true });
        resolveStarted();
        await aborted;
        return { finalText: '', stopReason: 'aborted', iterations: 1, goalComplete: false };
      },
    }) as never);

    const pending = runner({ sessionId: 'abort-session', terminalId: 'abort-terminal', prompt: 'inspect', goalLoop: true });
    await started;
    expect(abortAgentTurn('abort-session', 'abort-terminal')).toBe(true);
    await expect(pending).resolves.toMatchObject({ stopReason: 'aborted', goalLoop: true });
  });
});

// 🪪 TUI-SESSION-BOOT — 새 TUI(`src/tui/entry.ts` → `elanous repl --json --stdin-jsonl`)는
//    legacy 대시보드 preamble 부트 경로를 지나지 않는다. 그래서 자리 역할·미읽음 수는
//    `src/repl/index.ts` 의 시스템 프롬프트 «한 곳»(`buildReplSystemPrompt`)에서 실린다.
describe('새 TUI REPL 시스템 프롬프트 — 자리 부트 카드(TUI-SESSION-BOOT)', () => {
  const fakeConfig = {
    llm: { model: '' },
    chat: { conciseness: 'balanced', toolDeny: [] },
  } as unknown as UserConfig;

  /** 홈에 자리(seat-state/OP ⊕ seats/OP/AGENTS.local.md)와 OP 앞 미읽은 우편 1통을 세운다.
   *  cwd 는 «자리가 아닌» 임시 디렉터리 — 자리 판정은 COORD_ID 로만 선다(그래서 두 호출의 base 가 같다). */
  function seatFixture(): { home: string; cwd: string; msgPath: string; store: MsgStore } {
    const home = mkdtempSync(join(tmpdir(), 'repl-seatboot-'));
    const cwd = mkdtempSync(join(tmpdir(), 'repl-turn-'));
    mkdirSync(join(home, 'elanous-hq', 'seat-state', 'OP'), { recursive: true });
    const seatDir = join(home, 'elanous-hq', 'seats', 'OP');
    mkdirSync(seatDir, { recursive: true });
    writeFileSync(join(seatDir, 'AGENTS.local.md'), '역할 = 판정 제안 담당\n');
    const msgPath = join(home, 'state', 'msg', 'messages.db');
    const store = new MsgStore(msgPath);
    store.post({ from: 'TC', to: 'OP', body: 'repl-zero-guidance-mail' });
    return { home, cwd, msgPath, store };
  }

  const seatDeps = (home: string, msgPath: string) => ({ home, msgPath, env: { COORD_ID: 'OP' } });
  const plainDeps = (home: string, msgPath: string) => ({ home, msgPath, env: {} });

  test('자리 REPL 첫 턴 — 역할·미읽음 수가 «한 번» 들어간다', () => {
    const f = seatFixture();
    try {
      resetSeatBootCacheForTest();
      const prompt = buildReplSystemPrompt({
        cfg: fakeConfig,
        enabledToolNames: undefined,
        cwd: f.cwd,
        sessionId: 'repl-seat-session',
        seatBootDeps: seatDeps(f.home, f.msgPath),
      });

      expect(prompt).toBeDefined();
      const text = prompt!;
      expect(text).toContain('# OP 자리 부팅 카드');
      expect(text).toContain('역할: 판정 제안 담당');
      expect(text).toContain('안 읽은 msg 1 (OP)');
      // «한 번» — 카드 머리말과 자리 제목이 각각 정확히 한 번이다.
      expect(text.split('## 자리 부트 카드').length - 1).toBe(1);
      expect(text.split('# OP 자리 부팅 카드').length - 1).toBe(1);
      // 같은 대화의 다음 턴도 같은 문면 — 매 턴 카드가 겹쳐 붙지 않는다.
      expect(buildReplSystemPrompt({
        cfg: fakeConfig,
        enabledToolNames: undefined,
        cwd: f.cwd,
        sessionId: 'repl-seat-session',
        seatBootDeps: seatDeps(f.home, f.msgPath),
      })).toBe(text);
    } finally {
      f.store.close();
      rmSync(f.home, { recursive: true, force: true });
      rmSync(f.cwd, { recursive: true, force: true });
    }
  });

  test('비자리 REPL — 주입 0건', () => {
    const f = seatFixture();
    try {
      resetSeatBootCacheForTest();
      // 자리 상태·역할은 홈에 «있지만» cwd 가 자리가 아니고 COORD_ID 도 없다 ⇒ 카드 없음.
      expect(buildReplSystemPrompt({
        cfg: fakeConfig,
        enabledToolNames: undefined,
        cwd: f.cwd,
        sessionId: 'repl-plain-session',
        seatBootDeps: plainDeps(f.home, f.msgPath),
      })).toBeUndefined();
      // 도구가 켜져 범용 preamble 이 실려도 자리 카드는 한 줄도 안 섞인다.
      const withTools = buildReplSystemPrompt({
        cfg: fakeConfig,
        enabledToolNames: [],
        cwd: f.cwd,
        sessionId: 'repl-plain-session',
        seatBootDeps: plainDeps(f.home, f.msgPath),
      });
      expect(withTools ?? '').not.toContain('자리 부트 카드');
      expect(withTools ?? '').not.toContain('안 읽은 msg');
    } finally {
      f.store.close();
      rmSync(f.home, { recursive: true, force: true });
      rmSync(f.cwd, { recursive: true, force: true });
    }
  });

  test('자리 카드는 앞선 범용 preamble 을 밀어내지 않고 뒤에 붙는다', () => {
    const f = seatFixture();
    try {
      resetSeatBootCacheForTest();
      const plain = buildReplSystemPrompt({
        cfg: fakeConfig,
        enabledToolNames: [],
        cwd: f.cwd,
        sessionId: 'repl-compose-session',
        seatBootDeps: plainDeps(f.home, f.msgPath),
      });
      resetSeatBootCacheForTest();
      const cardOnly = buildReplSystemPrompt({
        cfg: fakeConfig,
        enabledToolNames: undefined,
        cwd: f.cwd,
        sessionId: 'repl-compose-session',
        seatBootDeps: seatDeps(f.home, f.msgPath),
      });
      const seated = buildReplSystemPrompt({
        cfg: fakeConfig,
        enabledToolNames: [],
        cwd: f.cwd,
        sessionId: 'repl-compose-session',
        seatBootDeps: seatDeps(f.home, f.msgPath),
      });

      expect(cardOnly).toBeDefined();
      expect(seated).toBe(plain === undefined ? cardOnly! : `${plain}\n\n${cardOnly!}`);
    } finally {
      f.store.close();
      rmSync(f.home, { recursive: true, force: true });
      rmSync(f.cwd, { recursive: true, force: true });
    }
  });
});

// 대표 2026-08-17 — "B 관측을 먼저 만들어주세요".
// 📏 그 전 실물: `btop 을 실행해주세요` 턴이 남긴 것은 turn.begin·turn.end 둘뿐이었고
//    툴 호출 관측이 «한 줄도» 없어서, 「실행했는데 화면이 안 바뀐 것」인지
//    「애초에 아무것도 실행 안 한 것」인지 사람이 가를 수 없었다.
describe('REPL agent 턴이 「도구를 썼나」를 관측에 남긴다', () => {
  function captureDebug(): { rows: Array<{ event: string; data: Record<string, unknown> }>; restore: () => void } {
    const rows: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    const originalEnabled = debug.enabled;
    if (!originalEnabled) debug.setDiagEnabled(true);
    (debug as { log: typeof debug.log }).log = ((category: string, event: string, data?: unknown) => {
      if (category === 'webterm.agent') rows.push({ event, data: (data ?? {}) as Record<string, unknown> });
    }) as typeof debug.log;
    return {
      rows,
      restore: () => {
        (debug as { log: typeof debug.log }).log = original;
        if (!originalEnabled) debug.setDiagEnabled(false);
      },
    };
  }

  test('도구를 «한 번도» 안 쓴 턴은 turn.end 에 toolCalls 0 을 «값으로» 남긴다', async () => {
    const cap = captureDebug();
    try {
      const runner = createAgentTurnRunner(createDeps({
        runner: async (opts: { request: { sessionId: string } }) => ({
          sessionId: opts.request.sessionId, text: '이미 실행 중입니다', stopReason: 'end_turn',
        }),
      }) as never);
      await runner({ sessionId: 's-none', terminalId: 'preview-1', prompt: 'btop 을 실행해주세요' });
      const end = cap.rows.find((r) => r.event === 'turn.end');
      expect(end).toBeDefined();
      expect(end!.data.toolCalls).toBe(0);          // ⭐ 「안 썼다」가 측정된 사실이 된다
      expect(cap.rows.some((r) => r.event === 'tool.call')).toBe(false);
    } finally { cap.restore(); }
  });

  test('도구를 쓴 턴은 호출마다 tool.call 을 남기고 총계가 맞는다 ⊕ 호출자 콜백은 그대로 간다', async () => {
    const cap = captureDebug();
    const seenByCaller: string[] = [];
    try {
      const runner = createAgentTurnRunner(createDeps({
        runner: async (opts: {
          request: { sessionId: string };
          onToolCall?: (i: { id: string; name: string; args: Record<string, unknown> }) => void;
        }) => {
          opts.onToolCall?.({ id: 't1', name: 'PtyShellSend', args: { sessionId: 'x', input: 'btop\n' } });
          opts.onToolCall?.({ id: 't2', name: 'PtyShellSnapshot', args: { sessionId: 'x' } });
          return { sessionId: opts.request.sessionId, text: '실행했습니다', stopReason: 'end_turn' };
        },
      }) as never);
      await runner({
        sessionId: 's-tools',
        terminalId: 'self_8f9da868',
        prompt: 'btop 을 실행해주세요',
        onToolCall: (i: { name: string }) => { seenByCaller.push(i.name); },
      } as never);

      const calls = cap.rows.filter((r) => r.event === 'tool.call');
      expect(calls).toHaveLength(2);
      expect(calls[0].data.name).toBe('PtyShellSend');
      expect(calls[0].data.seq).toBe(1);
      expect(calls[0].data.terminalId).toBe('self_8f9da868');
      // ⛔ 값이 아니라 키만 실린다 — 인자에 토큰·경로가 실릴 수 있다.
      expect(calls[0].data.argKeys).toEqual(['sessionId', 'input']);
      expect(JSON.stringify(calls[0].data)).not.toContain('btop\\n');
      expect(calls[1].data.seq).toBe(2);

      const end = cap.rows.find((r) => r.event === 'turn.end');
      expect(end!.data.toolCalls).toBe(2);
      // 래퍼가 호출자 콜백을 «삼키지 않는다»
      expect(seenByCaller).toEqual(['PtyShellSend', 'PtyShellSnapshot']);
    } finally { cap.restore(); }
  });
});
