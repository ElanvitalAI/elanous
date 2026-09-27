import { describe, expect, it } from 'bun:test';
import {
  runDashboardChatMainPlainTurn,
  type DashboardChatMainPlainTurnRuntimeDeps,
} from '../src/dashboard/input/chat-main-plain-turn-runtime.js';
import { createControlSignalBus } from '../src/input/control-signal.js';
import type { ThinkingHandle } from '../src/thinking-line.js';
import { promptForPhase } from '../src/impl-discipline/index.js';
import { buildDashboardTurnPreamble } from '../src/dashboard/turn-preamble.js';
import { getUserConfig } from '../src/user-config.js';

function makeThinking(): ThinkingHandle {
  return {
    update() {},
    updateAnimated() {},
    updateMetrics() {},
    reflow() {},
    stop() {},
  };
}

function buildDeps(overrides: Partial<DashboardChatMainPlainTurnRuntimeDeps> = {}) {
  const calls: string[] = [];
  const chatHistory: unknown[] = [];
  const chatLines: string[] = [];
  const assistantState: Array<unknown> = [];
  const finalizeCalls: Array<{ status: 'completed' | 'interrupted' | 'failed'; error?: string }> = [];
  const errorLines: string[] = [];
  const actionEffects: unknown[] = [];
  const armedTurnRefs: Array<{ userText: string }> = [];
  const debugEvents: Array<{ category: string; event: string; payload: Record<string, unknown> }> = [];
  const userMsg = { content: 'user text' };

  const deps: DashboardChatMainPlainTurnRuntimeDeps = {
    userText: 'hello world',
    contextText: 'ctx',
    turnStartedAt: 123,
    debugLog: (category, event, payload) => { debugEvents.push({ category, event, payload }); },
    thinking: makeThinking(),
    benchmarkMode: false,
    attachedSessionId: null,
    chat: { history: chatHistory },
    chatLines,
    contextRegistry: {},
    loadAttachments: async (_reg) => { calls.push('load-attachments'); },
    sessionRegistry: {},
    sync: { some: 'sync' },
    chatFooterLine: { current: null },
    acpTurnRef: {},
    blockAttach: (line) => line,
    pushChatLine: (line) => { chatLines.push(line); calls.push(`chat:${String(line)}`); },
    pushDebugLine: (_line) => {},
    setChatScrollBottom: () => { calls.push('scroll-bottom'); },
    draw: () => {},
    pinChatTail: () => {},
    termCols: () => 120,
    getSessionCwd: () => '/tmp',
    getUserConfig: () => ({
      voice: { tts: { drainCooldownMs: 0 } },
    }),
    inspectActiveProvider: () => ({ model: 'gpt-test' }),
    getActivePluginName: () => undefined,
    buildTurnPromptRuntime: (userText, _turnId, inputSource) => {
      calls.push(`build-prompt-runtime:${userText}`);
      if (inputSource) calls.push(`build-prompt-source:${inputSource.kind}`);
      return { promptBankContext: 'prompt-bank', turnProfile: { surface: 'dashboard' } };
    },
    buildTurnMessage: ({ userText }) => {
      calls.push(`build-turn-message:${userText}`);
      return { userMsg };
    },
    beginCodeEditTurn: async () => { calls.push('begin-code-edit-turn'); },
    buildTurnPreamble: () => {
      calls.push('build-turn-preamble');
      return ['preamble'];
    },
    runAutoCompact: async () => { calls.push('run-auto-compact'); },
    attachChatStreamingKeys: (_abortCtrl) => {
      calls.push('attach-streaming-keys');
      return () => { calls.push('cleanup-streaming-keys'); };
    },
    createOptionalSpecs: async () => {
      calls.push('create-optional-specs');
      return [{ name: 'tool' }];
    },
    createTurnStreamRuntime: (initialAssistantStart) => {
      calls.push(`create-turn-stream-runtime:${initialAssistantStart}`);
      let assistantStart = initialAssistantStart;
      return {
        onText: (_chunk: string, _accumulated: string) => { calls.push('stream:onText'); },
        onToolCall: (_call: unknown) => {
          assistantStart += 1;
          calls.push('stream:onToolCall');
        },
        onToolResult: (_call: unknown) => {
          assistantStart += 1;
          calls.push('stream:onToolResult');
        },
        getAssistantStart: () => assistantStart,
      };
    },
    runTurnUsageRuntime: (_usage) => { calls.push('run-turn-usage'); },
    runTurnPrelude: () => {
      calls.push('run-turn-prelude');
      return { searchPlannerState: { id: 'search' } };
    },
    armAcpTurnRef: (args) => {
      armedTurnRefs.push({ userText: args.userText });
      calls.push('arm-turn-ref');
    },
    resetAcpTurnRef: () => { calls.push('reset-turn-ref'); },
    acpSession: {
      send: async ({ onText, onToolCall, onToolResult, onUsage }) => {
        calls.push('acp:send');
        onText('hello');
        onToolCall({ tool: 'bash' });
        onToolResult({ ok: true });
        onUsage({ tokens: 3 });
      },
    },
    autoTts: {
      pushChunk: (_chunk) => { calls.push('tts:push'); },
      commit: async () => { calls.push('tts:commit'); },
      cancel: async () => { calls.push('tts:cancel'); },
    },
    voiceChat: {
      getPhase: () => 'processing',
      transitionToSpeaking: () => { calls.push('voice:speaking'); },
      notifyResponseDone: () => { calls.push('voice:done'); },
    },
    finalizeStreamLifecycle: (cleanupEsc, _aborted, status) => {
      cleanupEsc();
      calls.push(`finalize-stream:${status}`);
      return status;
    },
    recordTurnMetrics: async (_fullResponse) => { calls.push('record-turn-metrics'); },
    commitAssistantRenderState: (fullResponse, assistantStart, nextLine) => {
      calls.push(`commit-assistant:${fullResponse}:${assistantStart}:${nextLine}`);
      return {
        lastAssistantRaw: fullResponse,
        lastAssistantRange: { from: assistantStart, to: nextLine },
        lastAssistantMode: 'rendered',
      };
    },
    applyAssistantRenderState: (state) => {
      assistantState.push(state);
      calls.push('apply-assistant-state');
    },
    runTailAutoCopy: async () => { calls.push('tail-auto-copy'); },
    runCodeEditPostTurn: async () => { calls.push('code-edit-post-turn'); },
    runHandoffMirror: async () => { calls.push('handoff-mirror'); },
    parseActionBlock: () => null,
    isBrowseMode: () => false,
    enterSyncMode: () => { calls.push('enter-sync-mode'); },
    applyActionBlock: (_action, _sync) => {
      calls.push('apply-action-block');
      return { ok: true };
    },
    runActionEffects: async (outcome) => {
      actionEffects.push(outcome);
      calls.push('run-action-effects');
    },
    warningLine: (message) => `WARN:${message}`,
    pushErrorLine: (message) => {
      errorLines.push(message);
      calls.push(`error:${message}`);
    },
    finalizeTurn: (status, error) => {
      finalizeCalls.push({ status, error });
      calls.push(`finalize-turn:${status}`);
    },
    ...overrides,
  };

  return {
    deps,
    calls,
    chatHistory,
    chatLines,
    assistantState,
    finalizeCalls,
    errorLines,
    actionEffects,
    armedTurnRefs,
    debugEvents,
  };
}

async function implementationDisciplineFromDirectRuntime(
  nativeStructureEnabled: boolean,
  enabledTools: readonly string[],
): Promise<string> {
  let capturedPreamble: unknown[] = [];
  const ctx = buildDeps({
    userText: 'login 폼 구현해줘',
    getSessionCwd: () => '/tmp',
    getUserConfig: () => {
      const config = getUserConfig();
      return {
        ...config,
        voice: { ...config.voice, tts: { ...config.voice.tts, drainCooldownMs: 0 } },
        chat: {
          ...config.chat,
          conciseness: {
            ...config.chat.conciseness,
            enabled: false,
            finalMessageMaxLines: 6,
            preambleMaxWords: 12,
            flatBullets: false,
          },
        },
        tools: { ...config.tools, nativeStructure: { enabled: nativeStructureEnabled } },
      };
    },
    buildTurnPreamble: (args) => buildDashboardTurnPreamble({
      userText: args.userText,
      cwd: args.cwd,
      turnProfile: args.turnProfile as never,
      userConfig: args.userConfig,
      enabledTools,
    }),
    runAutoCompact: async ({ preamble }) => {
      capturedPreamble = preamble;
    },
  });
  await runDashboardChatMainPlainTurn(ctx.deps);
  const message = capturedPreamble.find(item => item !== null
    && typeof item === 'object'
    && 'content' in item
    && typeof item.content === 'string'
    && item.content.includes('# 명시적 구현 요청 감지')) as { content: string } | undefined;
  expect(message).toBeDefined();
  return message!.content;
}

describe('runDashboardChatMainPlainTurn', () => {
  it('direct runtime preserves static implementation-discipline bytes when native structure is off', async () => {
    expect(await implementationDisciplineFromDirectRuntime(false, ['Grep', 'Glob', 'Read']))
      .toBe(promptForPhase('implementation-ready'));
  }, 15_000);

  it('direct runtime renders active kinds and omits absent kind directives when native structure is on', async () => {
    const content = await implementationDisciplineFromDirectRuntime(true, ['Grep', 'Glob', 'Read']);
    expect(content).toContain('Grep/Glob/Read 로 surface 를 먼저 조사');
    expect(content).not.toContain('1~2 파일의 명확한 수정');
    expect(content).toContain('EnterPlanMode');
  }, 15_000);

  it('orchestrates the happy path and finalizes completed', async () => {
    const ctx = buildDeps();
    await runDashboardChatMainPlainTurn(ctx.deps);

    expect(ctx.chatHistory).toHaveLength(1);
    expect(ctx.chatLines[0]).toBe('');
    expect(ctx.calls).toContain('build-prompt-runtime:hello world');
    expect(ctx.calls).toContain('build-turn-message:hello world');
    expect(ctx.calls).toContain('run-auto-compact');
    expect(ctx.armedTurnRefs).toEqual([{ userText: 'hello world' }]);
    expect(ctx.calls).toContain('acp:send');
    expect(ctx.calls).toContain('run-turn-usage');
    expect(ctx.calls).toContain('record-turn-metrics');
    expect(ctx.calls).toContain('tail-auto-copy');
    expect(ctx.calls).toContain('code-edit-post-turn');
    expect(ctx.calls).toContain('handoff-mirror');
    expect(ctx.calls).toContain('finalize-turn:completed');
    expect(ctx.finalizeCalls).toEqual([{ status: 'completed', error: undefined }]);
    expect(ctx.errorLines).toEqual([]);
    expect(ctx.assistantState).toHaveLength(1);
  });

  it('passes only terminal session reference deps into the chat turn message', async () => {
    const registry = {};
    let args: Record<string, unknown> | undefined;
    const ctx = buildDeps({
      userText: '@pane:p1 안녕 [Text #1]',
      sessionRegistry: registry,
      buildTurnMessage: (input) => {
        args = input;
        return { userMsg: { content: input.userText } };
      },
    });
    await runDashboardChatMainPlainTurn(ctx.deps);
    expect(args).toBeDefined();
    expect(args?.userText).toBe('@pane:p1 안녕 [Text #1]');
    expect(args?.terminalRegistry).toBe(registry);
    expect(args).not.toHaveProperty('addressBook');
    expect(args).not.toHaveProperty('windowRegistry');
    expect(ctx.finalizeCalls).toEqual([{ status: 'completed', error: undefined }]);
  });

  it('attaches ESC handling before building the turn message', async () => {
    const ctx = buildDeps();
    await runDashboardChatMainPlainTurn(ctx.deps);

    expect(ctx.calls.indexOf('attach-streaming-keys'))
      .toBeLessThan(ctx.calls.indexOf('build-turn-message:hello world'));
  });

  it('interrupts during attachment loading without sending or preparing later stages', async () => {
    let abortCtrl: AbortController | undefined;
    const ctx = buildDeps({
      attachChatStreamingKeys: (ctrl) => {
        abortCtrl = ctrl;
        ctx.calls.push('attach-streaming-keys');
        return () => { ctx.calls.push('cleanup-streaming-keys'); };
      },
      loadAttachments: async () => {
        ctx.calls.push('load-attachments');
        abortCtrl!.abort();
      },
    });
    await runDashboardChatMainPlainTurn(ctx.deps);

    expect(ctx.calls).not.toContain('acp:send');
    expect(ctx.calls).not.toContain('build-turn-message:hello world');
    expect(ctx.finalizeCalls).toEqual([{ status: 'interrupted', error: undefined }]);
    expect(ctx.debugEvents).toContainEqual({
      category: 'chat-main.plain-turn',
      event: 'aborted-before-stream',
      payload: { stage: 'loadAttachments' },
    });
  });

  it('loads attachments BEFORE building the turn message (image paste delivery)', async () => {
    // Regression: pasted image attachments register with loaded:false / no
    // base64; buildMessagesWithContext drops them unless loadAllAttachments
    // ran first. The runtime must materialize attachments before the turn
    // message is assembled, else the [Image #N] token reaches the model as
    // text but the pixels never do.
    const ctx = buildDeps();
    await runDashboardChatMainPlainTurn(ctx.deps);

    const loadIdx = ctx.calls.indexOf('load-attachments');
    const buildIdx = ctx.calls.indexOf('build-turn-message:hello world');
    expect(loadIdx).toBeGreaterThanOrEqual(0);
    expect(buildIdx).toBeGreaterThanOrEqual(0);
    expect(loadIdx).toBeLessThan(buildIdx);
  });

  it('prefers submit-turn intent text when present', async () => {
    const ctx = buildDeps({
      userText: 'raw fallback text',
      intent: {
        kind: 'submit-turn',
        source: { kind: 'keyboard', surface: 'dashboard-chat-main' },
        text: 'intent text',
        route: 'plain',
      },
    });
    await runDashboardChatMainPlainTurn(ctx.deps);

    expect(ctx.chatHistory).toHaveLength(1);
    expect(ctx.calls).toContain('build-prompt-runtime:intent text');
    expect(ctx.calls).toContain('build-turn-message:intent text');
    expect(ctx.calls).toContain('build-prompt-source:keyboard');
    expect(ctx.armedTurnRefs).toEqual([{ userText: 'intent text' }]);
    expect(ctx.finalizeCalls).toEqual([{ status: 'completed', error: undefined }]);
  });

  it('runs action effects when an action block is produced', async () => {
    const ctx = buildDeps({
      parseActionBlock: () => ({ run: true }),
      isBrowseMode: () => true,
    });
    await runDashboardChatMainPlainTurn(ctx.deps);

    expect(ctx.calls).toContain('enter-sync-mode');
    expect(ctx.calls).toContain('apply-action-block');
    expect(ctx.calls).toContain('run-action-effects');
    expect(ctx.actionEffects).toEqual([{ ok: true }]);
  });

  it('pushes an error line and finalizes failed when the stream send throws', async () => {
    const ctx = buildDeps({
      acpSession: {
        send: async () => {
          throw new Error('stream exploded');
        },
      },
    });
    await runDashboardChatMainPlainTurn(ctx.deps);

    expect(ctx.errorLines).toEqual(['stream exploded']);
    expect(ctx.finalizeCalls).toEqual([{ status: 'failed', error: 'stream exploded' }]);
    expect(ctx.calls).toContain('finalize-turn:failed');
  });

  it('uses JSON-RPC internal-error details for the failed-turn summary and error line', async () => {
    const detail = 'LLM API 500: {"error":{"message":"fake upstream exploded"}}';
    const ctx = buildDeps({
      acpSession: {
        send: async () => {
          throw { code: -32603, message: 'Internal error', data: { details: detail } };
        },
      },
    });
    await runDashboardChatMainPlainTurn(ctx.deps);

    expect(ctx.errorLines).toEqual([detail]);
    expect(ctx.finalizeCalls).toEqual([{ status: 'failed', error: detail }]);
  });

  it('truncates the first line of a selected error detail in the failed-turn summary', async () => {
    const detail = 'x'.repeat(200);
    const ctx = buildDeps({
      acpSession: {
        send: async () => {
          throw { code: -32603, message: 'Internal error', data: { details: detail } };
        },
      },
    });
    await runDashboardChatMainPlainTurn(ctx.deps);

    expect(ctx.errorLines).toEqual([detail]);
    expect(ctx.finalizeCalls).toEqual([{ status: 'failed', error: `${'x'.repeat(80)}…` }]);
    expect(ctx.finalizeCalls[0]!.error).toHaveLength(81);
  });

  it('preserves the existing JSON-RPC empty-detail fallback in the error line', async () => {
    const ctx = buildDeps({
      acpSession: {
        send: async () => {
          throw { code: -32603, message: 'Internal error', data: { details: '' } };
        },
      },
    });
    await runDashboardChatMainPlainTurn(ctx.deps);

    expect(ctx.errorLines).toEqual(['Internal error']);
    expect(ctx.finalizeCalls).toEqual([{ status: 'failed', error: 'Internal error' }]);
  });

  it('keeps a nonempty detail with a blank first line instead of falling back', async () => {
    const detail = '   \nsecond diagnostic line';
    const ctx = buildDeps({
      acpSession: {
        send: async () => {
          throw { code: -32603, message: 'Internal error', data: { details: detail } };
        },
      },
    });
    await runDashboardChatMainPlainTurn(ctx.deps);

    expect(ctx.errorLines).toEqual([detail]);
    expect(ctx.finalizeCalls).toEqual([{ status: 'failed', error: '' }]);
  });

  it('preserves redaction in selected JSON-RPC details for both error surfaces', async () => {
    const ctx = buildDeps({
      acpSession: {
        send: async () => {
          throw {
            code: -32603,
            message: 'Internal error',
            data: { details: 'LLM API 500: sk-abcdefghijklmnopqrstuvwxyz123456' },
          };
        },
      },
    });
    await runDashboardChatMainPlainTurn(ctx.deps);

    expect(ctx.errorLines).toEqual(['LLM API 500: sk-***']);
    expect(ctx.finalizeCalls).toEqual([{ status: 'failed', error: 'LLM API 500: sk-***' }]);
  });

  it('cleans up ESC handling once when optional spec creation fails', async () => {
    const ctx = buildDeps({
      createOptionalSpecs: async () => {
        ctx.calls.push('create-optional-specs');
        throw new Error('optional specs exploded');
      },
    });
    await runDashboardChatMainPlainTurn(ctx.deps);

    expect(ctx.calls.filter(call => call === 'cleanup-streaming-keys')).toHaveLength(1);
    expect(ctx.finalizeCalls).toEqual([{ status: 'failed', error: 'optional specs exploded' }]);
  });

  it('cleans up ESC handling once after a completed turn', async () => {
    const ctx = buildDeps();
    await runDashboardChatMainPlainTurn(ctx.deps);

    expect(ctx.calls.filter(call => call === 'cleanup-streaming-keys')).toHaveLength(1);
    expect(ctx.finalizeCalls).toEqual([{ status: 'completed', error: undefined }]);
  });

  it('finalizes a failed turn when ESC cleanup throws', async () => {
    const ctx = buildDeps({
      createOptionalSpecs: async () => {
        throw new Error('optional specs exploded');
      },
      attachChatStreamingKeys: () => () => {
        throw new Error('cleanup exploded');
      },
    });

    await expect(runDashboardChatMainPlainTurn(ctx.deps)).rejects.toThrow('cleanup exploded');
    expect(ctx.finalizeCalls).toEqual([{ status: 'failed', error: 'optional specs exploded' }]);
  });

  it('strips optional specs on recent tool-exposure-stop quick-pass', async () => {
    const bus = createControlSignalBus(() => new Date().toISOString());
    bus.emit({
      kind: 'tool-exposure-stop',
      urgency: 'quick-pass',
      source: 'tool',
      mayPreempt: true,
      scope: { surface: 'chat-main', channel: 'dashboard' },
    });
    const armed: Array<unknown[]> = [];
    const ctx = buildDeps({
      control: { signalBus: bus },
      armAcpTurnRef: ({ optionalSpecs }) => {
        armed.push([...optionalSpecs]);
      },
    });
    await runDashboardChatMainPlainTurn(ctx.deps);

    expect(armed).toEqual([[]]);
  });
});
