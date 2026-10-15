import { describe, expect, it } from 'bun:test';
import { bootDashboardAcpSession } from '../src/dashboard/acp-boot.js';
import { runDashboardAutoCompact } from '../src/dashboard/auto-compact-runtime.js';
import { runCompactPipeline } from '../src/compact/pipeline.js';
import {
  runDashboardChatMainPlainTurn,
  type DashboardChatMainPlainTurnRuntimeDeps,
} from '../src/dashboard/input/chat-main-plain-turn-runtime.js';
import { createControlSignalBus } from '../src/input/control-signal.js';
import type { ThinkingHandle } from '../src/thinking-line.js';
import { promptForPhase } from '../src/impl-discipline/index.js';
import { buildDashboardTurnPreamble } from '../src/dashboard/turn-preamble.js';
import { getUserConfig } from '../src/user-config.js';
import { setUserConfigOverlay } from '../src/user-config.js';
import { saveTokens } from '../src/oauth/store.js';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
    readToolDispatchCount: () => 0,
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
        // The isolated test env has no provider credentials, and
        // resolveActiveProvider() throws NoLlmProviderAvailableError for
        // provider 'auto' — pin a concrete provider so the preamble builder
        // renders implementation-discipline bytes deterministically (same
        // convention as dashboard-impl-discipline-native-structure.test.ts).
        llm: { ...config.llm, provider: 'grok' },
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
    const failed = ctx.debugEvents.find((event) => event.event === 'turn-failed');
    expect(failed?.category).toBe('chat-main.plain-turn');
    expect(failed?.payload).toMatchObject({ stage: expect.any(String), message: 'stream exploded' });
    expect(typeof failed?.payload.stackHead === 'string' || failed?.payload.stackHead === undefined).toBe(true);
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

  it('replaces a matched failure signature with a Korean notice and stages the raw error for /detail', async () => {
    const detail = 'Codex API 400: {"detail":"Bad Request"}';
    const notices: Array<{ notice: string; raw: string }> = [];
    const ctx = buildDeps({
      acpSession: { send: async () => { throw new Error(detail); } },
      pushFailureNotice: (notice, raw) => { notices.push({ notice, raw }); },
    });
    await runDashboardChatMainPlainTurn(ctx.deps);

    expect(ctx.errorLines).toEqual([]);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.raw).toBe(detail);
    expect(notices[0]!.notice).toMatch(/^⚠ .+ → \/session new .+ · 원문 \/detail open$/);
    expect(notices[0]!.notice).not.toMatch(/[A-Za-z]+(?:\s+[A-Za-z]+){3,}/);
    expect(ctx.finalizeCalls[0]!.error).not.toContain('Codex API');
  });

  it('keeps the raw error line when no failure-notice sink is wired', async () => {
    const detail = 'Codex API 400: {"detail":"Bad Request"}';
    const ctx = buildDeps({ acpSession: { send: async () => { throw new Error(detail); } } });
    await runDashboardChatMainPlainTurn(ctx.deps);

    expect(ctx.errorLines).toEqual([detail]);
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

  it('logs first-token exactly once for the first non-empty text chunk with ISO coordinates', async () => {
    const turnStartedAt = Date.now() - 50;
    const ctx = buildDeps({
      turnStartedAt,
      acpSession: {
        send: async ({ onText, onToolCall }) => {
          onToolCall({ tool: 'bash' });
          onText('');
          onText('first chunk');
          onText('second chunk');
        },
      },
    });
    await runDashboardChatMainPlainTurn(ctx.deps);

    const firstTokenEvents = ctx.debugEvents.filter(
      event => event.category === 'chat.turn' && event.event === 'first-token',
    );
    expect(firstTokenEvents).toHaveLength(1);
    const payload = firstTokenEvents[0]!.payload;
    expect(payload.turnStartedAt).toBe(turnStartedAt);
    expect(typeof payload.ms).toBe('number');
    expect(payload.ms as number).toBeGreaterThanOrEqual(0);
    expect(payload.turnStartedAtIso).toBe(new Date(turnStartedAt).toISOString());
    expect(typeof payload.firstTokenAtIso).toBe('string');
    expect(ctx.finalizeCalls).toEqual([{ status: 'completed', error: undefined }]);
  });

  it('emits no first-token record when every text chunk is empty', async () => {
    const ctx = buildDeps({
      acpSession: {
        send: async ({ onText }) => {
          onText('');
          onText('');
        },
      },
    });
    await runDashboardChatMainPlainTurn(ctx.deps);

    expect(ctx.debugEvents.filter(event => event.event === 'first-token')).toHaveLength(0);
    expect(ctx.finalizeCalls).toEqual([{ status: 'completed', error: undefined }]);
  });

  it('emits no first-token record when the turn is aborted before any text', async () => {
    let abortCtrl: AbortController | undefined;
    const ctx = buildDeps({
      attachChatStreamingKeys: (ctrl) => {
        abortCtrl = ctrl;
        return () => {};
      },
      loadAttachments: async () => {
        abortCtrl!.abort();
      },
    });
    await runDashboardChatMainPlainTurn(ctx.deps);

    expect(ctx.debugEvents.filter(event => event.event === 'first-token')).toHaveLength(0);
    expect(ctx.calls).not.toContain('acp:send');
    expect(ctx.finalizeCalls).toEqual([{ status: 'interrupted', error: undefined }]);
  });

  it('does not count text delivered after stream cancellation as a first token', async () => {
    let abortCtrl: AbortController | undefined;
    const ctx = buildDeps({
      attachChatStreamingKeys: (ctrl) => {
        abortCtrl = ctrl;
        return () => {};
      },
      acpSession: {
        send: async ({ onText }) => {
          abortCtrl!.abort();
          onText('late chunk');
        },
      },
    });
    await runDashboardChatMainPlainTurn(ctx.deps);

    expect(ctx.debugEvents.filter(event => event.event === 'first-token')).toHaveLength(0);
  });

  it('keeps the turn running when the first-token debug log throws', async () => {
    const ctx = buildDeps({
      debugLog: (category, event) => {
        if (category === 'chat.turn' && event === 'first-token') {
          throw new Error('debug log exploded');
        }
      },
      acpSession: {
        send: async ({ onText }) => {
          onText('still streams');
        },
      },
    });
    await runDashboardChatMainPlainTurn(ctx.deps);

    expect(ctx.calls).toContain('stream:onText');
    expect(ctx.calls).toContain('record-turn-metrics');
    expect(ctx.errorLines).toEqual([]);
    expect(ctx.finalizeCalls).toEqual([{ status: 'completed', error: undefined }]);
  });

  it('stamps the turn-start ISO coordinate on the streaming-keys-attached record', async () => {
    const ctx = buildDeps({ turnStartedAt: 123 });
    await runDashboardChatMainPlainTurn(ctx.deps);

    const attached = ctx.debugEvents.find(
      event => event.category === 'chat-main.plain-turn' && event.event === 'streaming-keys-attached',
    );
    expect(attached).toBeDefined();
    expect(attached!.payload.turnStartedAtIso).toBe('1970-01-01T00:00:00.123Z');
    expect(attached!.payload.turnStartedAt).toBe(123);
  });

  it('keeps the existing streaming-keys record when the turn timestamp is invalid', async () => {
    const ctx = buildDeps({ turnStartedAt: Number.NaN });
    await runDashboardChatMainPlainTurn(ctx.deps);

    const attached = ctx.debugEvents.find(
      event => event.category === 'chat-main.plain-turn' && event.event === 'streaming-keys-attached',
    );
    expect(attached).toBeDefined();
    expect(attached!.payload.userTextBytes).toBe(11);
    expect(attached!.payload.turnStartedAtIso).toBeUndefined();
  });

  it('repairs an orphan result once after pre-pass and generic Codex 400', async () => {
    let sends = 0;
    const ctx = buildDeps({
      buildTurnMessage: () => ({ userMsg: { role: 'user', content: 'hello world' } }),
      runAutoCompact: async ({ chatHistory, onPrePassApplied }) => {
        chatHistory[0] = { ...(chatHistory[0] as object) };
        onPrePassApplied();
      },
      acpSession: { send: async () => {
        sends++;
        if (sends === 1) throw new Error('Codex API 400: {"detail":"Bad Request"}');
      } },
    });
    ctx.chatHistory.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'orphan', content: 'old' }] });
    await runDashboardChatMainPlainTurn(ctx.deps);
    expect(sends).toBe(2);
    expect(ctx.chatHistory.some(message => JSON.stringify(message).includes('orphan'))).toBe(false);
    expect(ctx.debugEvents.some(event => event.event === 'pair-check' && event.payload.removedResults === 1)).toBe(true);
    expect(ctx.finalizeCalls[0]?.status).toBe('completed');
  });

  it('does not replace a message appended after pair inspection and before repair', async () => {
    let sends = 0;
    const lateMessage = { role: 'user', content: 'arrived after pair check' };
    const ctx = buildDeps({
      debugLog: (_category, event) => {
        if (event === 'pair-check') queueMicrotask(() => ctx.chatHistory.push(lateMessage));
      },
      runAutoCompact: async ({ chatHistory, onPrePassApplied }) => {
        chatHistory[0] = { ...(chatHistory[0] as object) };
        onPrePassApplied();
      },
      acpSession: { send: async () => {
        sends++;
        throw new Error('Codex API 400: {"detail":"Bad Request"}');
      } },
    });
    ctx.chatHistory.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'orphan', content: 'old' }] });
    await runDashboardChatMainPlainTurn(ctx.deps);
    expect(sends).toBe(1);
    expect(ctx.chatHistory.some(message => JSON.stringify(message).includes('orphan'))).toBe(true);
    expect(ctx.chatHistory).toContain(lateMessage);
    expect(ctx.chatLines.some(line => line.includes('/session new'))).toBe(true);
  });

  it('checks pairs and gives recovery guidance for a generic 400 body variant', async () => {
    let sends = 0;
    const ctx = buildDeps({
      runAutoCompact: async ({ chatHistory, onPrePassApplied }) => {
        chatHistory[0] = { ...(chatHistory[0] as object) };
        onPrePassApplied();
      },
      acpSession: { send: async () => {
        sends++;
        throw new Error('Codex API 400: { "detail": "Bad Request" }');
      } },
    });
    await runDashboardChatMainPlainTurn(ctx.deps);
    expect(sends).toBe(1);
    expect(ctx.debugEvents.some(event => event.event === 'pair-check')).toBe(true);
    expect(ctx.chatLines.some(line => line.includes('/session new'))).toBe(true);
  });

  it('caps retry at two sends and stops Thinking when repaired history still returns 400', async () => {
    let sends = 0;
    const stopped: string[] = [];
    const ctx = buildDeps({
      thinking: { ...makeThinking(), stop: opts => { stopped.push(opts?.status ?? 'completed'); } },
      buildTurnMessage: () => ({ userMsg: { role: 'user', content: 'continue' } }),
      runAutoCompact: async ({ chatHistory, onPrePassApplied }) => {
        chatHistory[0] = { ...(chatHistory[0] as object) };
        onPrePassApplied();
      },
      acpSession: { send: async () => {
        sends++;
        if (sends === 2) ctx.chatHistory.push({ role: 'user', content: 'followup during retry' });
        throw new Error('Codex API 400: {"detail":"Bad Request"}');
      } },
    });
    ctx.chatHistory.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'orphan', content: 'old' }] });
    await runDashboardChatMainPlainTurn(ctx.deps);
    expect(sends).toBe(2);
    expect(stopped).toEqual(['failed']);
    expect(ctx.finalizeCalls[0]?.status).toBe('failed');
    expect(ctx.chatLines.some(line => line.includes('/session new'))).toBe(true);
    expect(ctx.chatHistory.some(message => JSON.stringify(message).includes('orphan'))).toBe(true);
    expect(ctx.chatHistory.at(-1)).toEqual({ role: 'user', content: 'followup during retry' });
    expect(ctx.debugEvents.some(event => event.event === 'history-restored'
      && event.payload.preservedTail === 1)).toBe(true);
  });

  it('shows manual recovery if pair repair retry fails with a different error', async () => {
    let sends = 0;
    const ctx = buildDeps({
      buildTurnMessage: () => ({ userMsg: { role: 'user', content: 'continue' } }),
      runAutoCompact: async ({ chatHistory, onPrePassApplied }) => {
        chatHistory[0] = { ...(chatHistory[0] as object) };
        onPrePassApplied();
      },
      acpSession: { send: async () => {
        sends++;
        throw new Error(sends === 1
          ? 'Codex API 400: {"detail":"Bad Request"}' : 'transport disconnected');
      } },
    });
    ctx.chatHistory.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'orphan', content: 'old' }] });
    await runDashboardChatMainPlainTurn(ctx.deps);
    expect(sends).toBe(2);
    expect(ctx.chatLines.some(line => line.includes('/session new'))).toBe(true);
    expect(ctx.chatHistory.some(message => JSON.stringify(message).includes('orphan'))).toBe(true);
    expect(ctx.debugEvents.some(event => event.event === 'history-restored')).toBe(true);
  });

  it('does not overwrite a repaired prefix changed in place during the retry', async () => {
    let sends = 0;
    const ctx = buildDeps({
      runAutoCompact: async ({ chatHistory, onPrePassApplied }) => {
        chatHistory[0] = { ...(chatHistory[0] as object) };
        onPrePassApplied();
      },
      acpSession: { send: async () => {
        sends++;
        if (sends === 2) {
          (ctx.chatHistory[0] as { content: unknown }).content = 'changed during retry';
          throw new Error('transport disconnected');
        }
        throw new Error('Codex API 400: {"detail":"Bad Request"}');
      } },
    });
    ctx.chatHistory.push(
      { role: 'assistant', content: [{ type: 'tool_use', id: 'paired', name: 'Read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'paired', content: 'kept' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'orphan', content: 'old' }] },
    );
    await runDashboardChatMainPlainTurn(ctx.deps);
    expect(sends).toBe(2);
    expect((ctx.chatHistory[0] as { content: unknown }).content).toBe('changed during retry');
    expect(ctx.debugEvents.some(event => event.event === 'history-restore-skipped')).toBe(true);
    expect(ctx.chatLines.some(line => line.includes('/session new'))).toBe(true);
  });

  it('does not retry after even an empty ACP text event', async () => {
    let sends = 0;
    const ctx = buildDeps({
      runAutoCompact: async ({ chatHistory, onPrePassApplied }) => {
        chatHistory[0] = { ...(chatHistory[0] as object) };
        onPrePassApplied();
      },
      acpSession: { send: async ({ onText }) => {
        sends++;
        onText('');
        throw new Error('Codex API 400: {"detail":"Bad Request"}');
      } },
    });
    await runDashboardChatMainPlainTurn(ctx.deps);
    expect(sends).toBe(1);
  });

  it('sends repaired pairs through the real local ACP path on the second Codex request', async () => {
    const root = mkdtempSync(join(tmpdir(), 'compact-prepass-wire-'));
    const envKeys = ['HOME', 'XDG_CONFIG_HOME', 'CODEX_HOME', 'ELANOUS_STATE_DIR',
      'ELANOUS_CODEX_ACCOUNT', 'ELANOUS_CODEX_ACCOUNT_HOME'] as const;
    const savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
    const originalFetch = globalThis.fetch;
    const bodies: Array<{ input: Array<Record<string, unknown>> }> = [];
    let boot: Awaited<ReturnType<typeof bootDashboardAcpSession>> | undefined;
    try {
    for (const key of envKeys) delete process.env[key];
    process.env.HOME = root;
    process.env.XDG_CONFIG_HOME = root;
    process.env.CODEX_HOME = join(root, 'codex-home');
    process.env.ELANOUS_STATE_DIR = root;
    mkdirSync(process.env.CODEX_HOME, { recursive: true });
    saveTokens('openai-codex', {
      accessToken: 'isolated-test-token', refreshToken: 'isolated-test-refresh',
      expiresAt: Date.now() + 3_600_000,
    }, { authMode: 'chatgpt', mirrorCodex: false });
    setUserConfigOverlay(config => ({ ...config,
      llm: { ...config.llm, provider: 'openai-codex', model: 'gpt-6-sol',
        baseUrl: 'https://test.invalid/backend-api/codex', codexStore: false },
    }));
    globalThis.fetch = (async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as { input: Array<Record<string, unknown>> });
      if (bodies.length <= 2) return new Response('{"detail":"Bad Request"}', {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
      return new Response('data: {"type":"response.output_text.delta","delta":"recovered"}\n\ndata: [DONE]\n\n', {
        status: 200, headers: { 'Content-Type': 'text/event-stream' },
      });
    }) as typeof fetch;
    let prePassApplied = 0;
    const ctx = buildDeps({
      buildTurnMessage: () => ({ userMsg: { role: 'user', content: 'continue' } }),
      runAutoCompact: async ({ preamble, chatHistory, userMsg, onPrePassApplied }) =>
        runDashboardAutoCompact({
          preamble: preamble as any, chatHistory: chatHistory as any, userMsg: userMsg as any,
          model: 'gpt-6-sol', autoCompactConfig: {} as any,
          shouldAutoCompact: () => ({ fire: false, partial: false, preserveLastN: 4,
            reason: 'under-threshold', ratio: 0.1, usedTokens: 100, maxTokens: 1000 }),
          compactConversation: async () => ({ summary: '' }),
          compactConversationPartial: async () => ({ summary: '' }),
          renderCompactBoundary: () => '', pushChatLine: () => {}, pushDebugLine: () => {},
          muted: text => text, debugLog: () => {},
          onPrePassApplied: () => { prePassApplied++; onPrePassApplied(); },
          runCompactPipeline: (messages, opts) => runCompactPipeline(messages, {
            sessionId: opts.sessionId,
            policy: { archiveEnabled: false, toolOutputCharBudget: 1000,
              microcompactAgeThreshold: 5, preserveLastN: 4 },
          }),
        }),
    });
    for (let i = 0; i < 65; i++) {
      const id = `call_${i}`;
      ctx.chatHistory.push(
        { role: 'user', content: `request ${i}` },
        { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input: { path: `file-${i}` } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: id,
          content: `result ${i}\n${'x'.repeat(4000)}` }] },
      );
    }
    ctx.chatHistory.push(
      { role: 'assistant', content: [{ type: 'tool_use', id: 'paired', name: 'Read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'paired', content: 'kept' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'orphan', content: 'drop' }] },
    );
    boot = await bootDashboardAcpSession({
      getCwd: () => '/tmp', getChatHistory: () => ctx.chatHistory as any,
      getPreamble: () => [],
      getTools: () => [{ name: 'echo', description: 'test', parameters: { type: 'object', properties: {} } }],
      getActiveModel: () => 'gpt-6-sol', dispatchTool: async () => null,
      pushTurnToolHistory: () => {},
    });
      ctx.deps.acpSession = boot.session as any;
      ctx.deps.readToolDispatchCount = () => 0;
      await runDashboardChatMainPlainTurn(ctx.deps);
      expect(prePassApplied).toBe(1);
      expect(bodies).toHaveLength(3);
      const first = bodies[0]!.input;
      expect(bodies[1]!.input).toEqual(first); // provider's own HTTP retry precedes the TUI repair
      const second = bodies[2]!.input;
      expect(JSON.stringify(first)).toContain('orphan');
      expect(JSON.stringify(second)).not.toContain('orphan');
      const callIndex = second.findIndex(item => 'type' in item
        && item.type === 'function_call' && item.call_id === 'paired');
      const resultIndex = second.findIndex(item => 'type' in item
        && item.type === 'function_call_output' && item.call_id === 'paired');
      expect(callIndex).toBeGreaterThanOrEqual(0);
      expect(resultIndex).toBeGreaterThan(callIndex);
      expect(ctx.finalizeCalls[0]?.status).toBe('completed');
    } finally {
      try { await boot?.session.close(); } catch { /* preserve global test isolation */ }
      globalThis.fetch = originalFetch;
      setUserConfigOverlay(null);
      for (const key of envKeys) {
        const value = savedEnv[key];
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not retry ambiguous duplicate call IDs after pre-pass 400', async () => {
    let sends = 0;
    const stopped: string[] = [];
    const ctx = buildDeps({
      thinking: { ...makeThinking(), stop: opts => { stopped.push(opts?.status ?? 'completed'); } },
      runAutoCompact: async ({ chatHistory, onPrePassApplied }) => {
        chatHistory[0] = { ...(chatHistory[0] as object) };
        onPrePassApplied();
      },
      acpSession: { send: async () => {
        sends++;
        throw new Error('Codex API 400: {"detail":"Bad Request"}');
      } },
    });
    ctx.chatHistory.push(
      { role: 'assistant', content: [{ type: 'tool_use', id: 'same', name: 'Read', input: {} }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'same', name: 'Write', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'same', content: 'result' }] },
    );
    const before = JSON.stringify(ctx.chatHistory);
    await runDashboardChatMainPlainTurn(ctx.deps);
    expect(sends).toBe(1);
    expect(JSON.stringify(ctx.chatHistory)).toContain(before.slice(1, -1));
    expect(ctx.debugEvents.some(event => event.event === 'pair-check'
      && event.payload.ambiguousCount === 1)).toBe(true);
    expect(ctx.debugEvents.some(event => event.event === 'manual-recovery-required'
      && event.payload.reason === 'ambiguous-tool-pairing')).toBe(true);
    expect(stopped).toEqual(['failed']);
    expect(ctx.chatLines.some(line => line.includes('/session new'))).toBe(true);
  });

  it('shows manual recovery and stops Thinking when no safe pair repair exists', async () => {
    const stopped: string[] = [];
    let sends = 0;
    const ctx = buildDeps({
      thinking: { ...makeThinking(), stop: opts => { stopped.push(opts?.status ?? 'completed'); } },
      runAutoCompact: async ({ chatHistory, onPrePassApplied }) => {
        chatHistory[0] = { ...(chatHistory[0] as object) };
        onPrePassApplied();
      },
      acpSession: { send: async () => {
        sends++;
        throw new Error('Codex API 400: {"detail":"Bad Request"}');
      } },
    });
    await runDashboardChatMainPlainTurn(ctx.deps);
    expect(sends).toBe(1);
    expect(stopped).toEqual(['failed']);
    expect(ctx.chatLines.some(line => line.includes('/session new'))).toBe(true);
    expect(ctx.debugEvents.some(event => event.event === 'manual-recovery-required')).toBe(true);
  });

  it('does not retry when the server dispatched a tool before the ACP event reached the client', async () => {
    let dispatchCount = 0;
    let sends = 0;
    const ctx = buildDeps({
      buildTurnMessage: () => ({ userMsg: { role: 'user', content: 'continue' } }),
      runAutoCompact: async ({ chatHistory, onPrePassApplied }) => {
        chatHistory[0] = { ...(chatHistory[0] as object) };
        onPrePassApplied();
      },
      readToolDispatchCount: () => dispatchCount,
      acpSession: { send: async () => {
        sends++;
        dispatchCount++;
        throw new Error('Codex API 400: {"detail":"Bad Request"}');
      } },
    });
    ctx.chatHistory.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'orphan', content: 'old' }] });
    await runDashboardChatMainPlainTurn(ctx.deps);
    expect(sends).toBe(1);
    expect(ctx.chatLines.some(line => line.includes('/session new'))).toBe(true);
    expect(ctx.debugEvents.some(event => event.event === 'pair-check'
      && event.payload.removedResults === 1 && event.payload.readOnly === true)).toBe(true);
    expect(ctx.chatHistory.some(message => JSON.stringify(message).includes('orphan'))).toBe(true);
  });

  it('rechecks server dispatch after pair inspection before changing history', async () => {
    let dispatchCount = 0;
    let sends = 0;
    const ctx = buildDeps({
      debugLog: (_category, event) => {
        if (event === 'pair-check') queueMicrotask(() => { dispatchCount++; });
      },
      runAutoCompact: async ({ chatHistory, onPrePassApplied }) => {
        chatHistory[0] = { ...(chatHistory[0] as object) };
        onPrePassApplied();
      },
      readToolDispatchCount: () => dispatchCount,
      acpSession: { send: async () => {
        sends++;
        throw new Error('Codex API 400: {"detail":"Bad Request"}');
      } },
    });
    ctx.chatHistory.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'orphan', content: 'old' }] });
    await runDashboardChatMainPlainTurn(ctx.deps);
    expect(sends).toBe(1);
    expect(ctx.chatHistory.some(message => JSON.stringify(message).includes('orphan'))).toBe(true);
    expect(ctx.chatLines.some(line => line.includes('/session new'))).toBe(true);
  });

  it('rechecks dispatch observability immediately before repair resend', async () => {
    let reads = 0;
    let sends = 0;
    const ctx = buildDeps({
      runAutoCompact: async ({ chatHistory, onPrePassApplied }) => {
        chatHistory[0] = { ...(chatHistory[0] as object) };
        onPrePassApplied();
      },
      readToolDispatchCount: () => ++reads >= 3 ? null : 0,
      acpSession: { send: async () => {
        sends++;
        throw new Error('Codex API 400: {"detail":"Bad Request"}');
      } },
    });
    ctx.chatHistory.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'orphan', content: 'old' }] });
    await runDashboardChatMainPlainTurn(ctx.deps);
    expect(sends).toBe(1);
    expect(reads).toBe(3);
    expect(ctx.chatHistory.some(message => JSON.stringify(message).includes('orphan'))).toBe(true);
  });

  it('does not retry when a delayed ACP stream event arrives after the first 400', async () => {
    let sends = 0;
    let delayedText: ((chunk: string) => void) | undefined;
    const ctx = buildDeps({
      debugLog: (_category, event) => {
        if (event === 'pair-check') queueMicrotask(() => delayedText?.(''));
      },
      runAutoCompact: async ({ chatHistory, onPrePassApplied }) => {
        chatHistory[0] = { ...(chatHistory[0] as object) };
        onPrePassApplied();
      },
      acpSession: { send: async ({ onText }) => {
        sends++;
        delayedText = onText;
        throw new Error('Codex API 400: {"detail":"Bad Request"}');
      } },
    });
    ctx.chatHistory.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'orphan', content: 'old' }] });
    await runDashboardChatMainPlainTurn(ctx.deps);
    expect(sends).toBe(1);
    expect(ctx.chatHistory.some(message => JSON.stringify(message).includes('orphan'))).toBe(true);
    expect(ctx.chatLines.some(line => line.includes('/session new'))).toBe(true);
  });

  it('does not retry when server dispatch count is unavailable', async () => {
    let sends = 0;
    const ctx = buildDeps({
      runAutoCompact: async ({ chatHistory, onPrePassApplied }) => {
        chatHistory[0] = { ...(chatHistory[0] as object) };
        onPrePassApplied();
      },
      readToolDispatchCount: () => null,
      acpSession: { send: async () => {
        sends++;
        throw new Error('Codex API 400: {"detail":"Bad Request"}');
      } },
    });
    await runDashboardChatMainPlainTurn(ctx.deps);
    expect(sends).toBe(1);
  });

  it('does not enter pre-pass recovery after ordinary auto-compact alone', async () => {
    let sends = 0;
    const ctx = buildDeps({
      runAutoCompact: async ({ chatHistory }) => { chatHistory[0] = { role: 'assistant', content: 'normal summary' }; },
      acpSession: { send: async () => {
        sends++;
        throw new Error('Codex API 400: {"detail":"Bad Request"}');
      } },
    });
    await runDashboardChatMainPlainTurn(ctx.deps);
    expect(sends).toBe(1);
    expect(ctx.chatLines.some(line => line.includes('/session new'))).toBe(false);
  });
});
