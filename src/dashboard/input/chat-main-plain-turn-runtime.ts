import type { ThinkingHandle } from '../../thinking-line.js';
import { debug, redactSecretText } from '../../debug/log.js';
import type { SubmitTurnIntent } from '../../input/input-intent.js';
import type { InputSourceRef } from '../../input/input-source-kind.js';
import { findRecentQuickPassSignal } from '../../input/turn-submit-revision.js';
import type { ControlSignalBus } from '../../input/control-signal.js';
import type { DashboardTurnBlockAttachLike } from '../turn-message-runtime.js';
import type { DashboardAssistantRenderState } from '../turn-tail-runtime.js';
import type { SearchPlannerState } from '../../session-runtime/index.js';
import { runDashboardPlainTurnStream } from './dashboard-plain-turn-stream.js';

export interface DashboardChatMainPlainTurnRuntimeDeps {
  userText: string;
  intent?: SubmitTurnIntent;
  contextText: string;
  turnStartedAt: number;
  thinking: ThinkingHandle;
  benchmarkMode: boolean;
  attachedSessionId: string | null;

  chat: { history: unknown[] };
  chatLines: string[];
  contextRegistry: unknown;
  sessionRegistry: unknown;
  sync: unknown;
  chatFooterLine: { current: string | null };
  /** Essential-mode completion footer supplied by the actual route resolver. */
  routeFooter?: () => string | null;
  acpTurnRef: unknown;

  blockAttach: DashboardTurnBlockAttachLike;
  pushChatLine: (line: string) => void;
  pushDebugLine: (line: string) => void;
  setChatScrollBottom: () => void;
  draw: () => void;
  pinChatTail: () => void;
  termCols: () => number;
  getSessionCwd: () => string;
  getUserConfig: () => any;
  inspectActiveProvider: () => { model: string };
  getActivePluginName: () => string | undefined;
  control?: {
    signalBus: ControlSignalBus;
  };

  buildTurnPromptRuntime: (userText: string, turnId: string, inputSource?: InputSourceRef | null) => {
    promptBankContext: string;
    turnProfile: unknown;
  };
  /** Materialize unloaded attachments (image → base64/mediaType, docs →
   *  extracted text) before the turn message is built. Without this the
   *  plain-turn path pushes an image attachment with `loaded:false` /
   *  no base64, and `buildMessagesWithContext` silently drops it (its
   *  image filter requires `a.base64`) — the `[Image #N]` token reaches
   *  the model as text but the actual pixels never do. Idempotent:
   *  already-loaded attachments short-circuit. */
  loadAttachments: (registry: unknown) => Promise<void>;
  buildTurnMessage: (args: {
    userText: string;
    promptBankContext: string;
    contextText: string;
    contextRegistry: unknown;
    terminalRegistry: unknown;
    blockAttach: DashboardTurnBlockAttachLike;
    pushChatLine: (line: string) => void;
  }) => { userMsg: { content: unknown } };
  beginCodeEditTurn: (userContent: string) => Promise<void>;
  buildTurnPreamble: (args: {
    userText: string;
    cwd: string;
    turnProfile: unknown;
    userConfig: any;
  }) => unknown[];
  runAutoCompact: (args: {
    preamble: unknown[];
    chatHistory: unknown[];
    userMsg: unknown;
  }) => Promise<void>;

  attachChatStreamingKeys: (abortCtrl: AbortController) => () => void;
  /** ⭐ 관측 심 — 형제 `chat-main-entry-runtime` 과 «같은 형태»다(재발명 0 · `OBS-T124`). */
  debugLog?: (category: string, event: string, payload: Record<string, unknown>) => void;
  createOptionalSpecs: () => Promise<unknown[]>;
  createTurnStreamRuntime: (initialAssistantStart: number) => {
    onText(chunk: string, accumulated: string): void;
    onToolCall(call: unknown): void;
    onToolResult(call: unknown): void;
    getAssistantStart(): number;
  };
  runTurnUsageRuntime: (usage: unknown) => void;
  runTurnPrelude: (userText: string) => { searchPlannerState: SearchPlannerState };
  armAcpTurnRef: (args: {
    abortCtrl: AbortController;
    userText: string;
    turnProfile: unknown;
    searchPlannerState: SearchPlannerState;
    optionalSpecs: unknown[];
  }) => void;
  resetAcpTurnRef: () => void;
  acpSession: {
    // 반환은 await 후 result 만 참조(void 아님) — 구체 DashboardSession.send 가
    // Promise<DashboardSendResult> 를 돌려주므로 Promise<unknown> 로 수용.
    send(opts: {
      userText: string;
      signal: AbortSignal;
      onText: (chunk: string) => void;
      onToolCall: (call: unknown) => void;
      onToolResult: (call: unknown) => void;
      onUsage: (usage: unknown) => void;
    }): Promise<unknown>;
  };
  autoTts: {
    pushChunk: (chunk: string) => void;
    commit: () => void | Promise<void>;
    cancel: () => void | Promise<void>;
  };
  voiceChat: {
    getPhase: () => string;
    transitionToSpeaking: () => void;
    notifyResponseDone: () => void;
  };
  finalizeStreamLifecycle: (
    cleanupEsc: () => void,
    aborted: boolean,
    finalStatus: 'completed' | 'interrupted' | 'failed',
  ) => 'completed' | 'interrupted' | 'failed';
  recordTurnMetrics: (fullResponse: string) => Promise<void>;
  commitAssistantRenderState: (
    fullResponse: string,
    assistantStart: number,
    nextLine: number,
  ) => DashboardAssistantRenderState;
  applyAssistantRenderState: (state: DashboardAssistantRenderState) => void;
  runTailAutoCopy: (userText: string, fullResponse: string) => Promise<void>;
  runCodeEditPostTurn: () => Promise<void>;
  runHandoffMirror: (userContent: string, assistantContent: string) => Promise<void> | void;
  parseActionBlock: (fullResponse: string) => unknown;
  isBrowseMode: () => boolean;
  enterSyncMode: () => void;
  applyActionBlock: (action: unknown, sync: unknown) => unknown;
  runActionEffects: (outcome: unknown) => Promise<void>;
  warningLine: (message: string) => string;
  pushErrorLine: (message: string) => void;
  finalizeTurn: (status: 'completed' | 'interrupted' | 'failed', error?: string) => void;
}

/** Select a safe, actionable message for a failed dashboard chat turn. */
export function selectDashboardChatErrorDetail(err: unknown): string {
  const rpcError = err && typeof err === 'object'
    ? err as { code?: unknown; message?: unknown; data?: { details?: unknown } }
    : undefined;
  const details = rpcError?.code === -32603
    && rpcError.message === 'Internal error'
    && typeof rpcError.data?.details === 'string'
    ? rpcError.data.details
    : undefined;
  const fallback = (err as { message?: unknown } | null | undefined)?.message || String(err);
  return redactSecretText(String(details || fallback));
}

/**
 * PR-A plain-dispatch extract, slice 2:
 * lift the keyboard chat-main plain turn body into a callable runtime
 * without changing semantics. The orchestration stays dependency-
 * injected so future source flavors can reuse the same turn body.
 */
export async function runDashboardChatMainPlainTurn(
  deps: DashboardChatMainPlainTurnRuntimeDeps,
): Promise<void> {
  let finalStatus: 'completed' | 'interrupted' | 'failed' = 'completed';
  let finalError: string | undefined;
  const userText = deps.intent?.text ?? deps.userText;

  let cleanupEsc = () => {};

  try {
    const abortCtrl = new AbortController();
    let cleanedUp = false;
    const attachedCleanupEsc = deps.attachChatStreamingKeys(abortCtrl);
    cleanupEsc = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      attachedCleanupEsc();
    };
    // ⛔⭐⭐⭐ **「스트리밍 키 사다리가 «이 턴»에 걸렸나」를 값으로 남긴다**(2026-08-19 · `OBS-T124`).
    //
    // 🚨 왜 필요한가 — 대표 제보(*"스트리밍 중 친 발화가 큐에 안 쌓인다"*)를 라이브로 재현했더니
    //   ***`dashboard.turn-typeahead` 발화가 0***이었다(저장소 전 우주 마지막 발화 2026-08-15).
    //   즉 턴 중 타이핑을 흡수하는 설계 경로(`applyTurnTypeaheadKey`)가 ***한 번도 안 불린다***.
    //   ⇒ 그런데 「사다리를 «거는» 이 자리가 도는가」를 물을 표면이 ***없어서***,
    //     「사다리가 안 걸린 것」과 「걸렸는데 키가 딴 데로 간 것」을 ***원리상 못 갈랐다***.
    // ⭐ 이 한 줄이 그 둘을 가른다 — 이 이벤트가 «있는데» typeahead 가 0이면 후자다.
    // ⛔ 행동을 바꾸지 않는다(관측만). 처방은 `RFC-tui-mid-turn-input-queue-2026-08-19` §2 Q1.
    try {
      deps.debugLog?.('chat-main.plain-turn', 'streaming-keys-attached', {
        userTextBytes: Buffer.byteLength(userText ?? '', 'utf8'),
        turnStartedAt: deps.turnStartedAt,
      });
    } catch { /* fail-soft — 관측이 턴을 막지 않는다 */ }
    let stage = 'streaming-keys-attached';
    const finishIfAborted = (): boolean => {
      if (!abortCtrl.signal.aborted) return false;
      finalStatus = 'interrupted';
      try {
        deps.debugLog?.('chat-main.plain-turn', 'aborted-before-stream', { stage });
      } catch { /* fail-soft — 관측이 턴을 막지 않는다 */ }
      return true;
    };

    if (finishIfAborted()) return;
    const userConfig = deps.getUserConfig();

    const { promptBankContext, turnProfile } = deps.buildTurnPromptRuntime(
      userText,
      `dashboard:${deps.turnStartedAt}`,
      deps.intent?.source ?? null,
    );

    // Load pasted/attached files (image base64, doc text) so the turn
    // message actually carries the pixels/bytes, not just the token.
    await deps.loadAttachments(deps.contextRegistry);
    stage = 'loadAttachments';
    if (finishIfAborted()) return;

    const { userMsg } = deps.buildTurnMessage({
      userText,
      promptBankContext,
      contextText: deps.contextText,
      contextRegistry: deps.contextRegistry,
      terminalRegistry: deps.sessionRegistry,
      blockAttach: deps.blockAttach,
      pushChatLine: deps.pushChatLine,
    });
    deps.chat.history.push(userMsg);

    await deps.beginCodeEditTurn(
      typeof userMsg.content === 'string' ? userMsg.content : '',
    );
    stage = 'beginCodeEditTurn';
    if (finishIfAborted()) return;

    const preamble = deps.buildTurnPreamble({
      userText,
      cwd: deps.getSessionCwd(),
      turnProfile,
      userConfig,
    });

    await deps.runAutoCompact({
      preamble,
      chatHistory: deps.chat.history,
      userMsg,
    });
    stage = 'runAutoCompact';
    if (finishIfAborted()) return;

    deps.pushChatLine('');
    deps.setChatScrollBottom();

    let assistantStart = deps.chatLines.length;
    let optionalSpecs = await deps.createOptionalSpecs();
    stage = 'createOptionalSpecs';
    if (finishIfAborted()) return;
    if (deps.control) {
      const signal = findRecentQuickPassSignal({
        signalBus: deps.control.signalBus,
        scope: { surface: 'chat-main', channel: 'dashboard' },
        signalKinds: ['tool-exposure-stop'],
      });
      if (signal) {
        if (debug.enabled) {
          debug.log('input.control', 'pre-exposure.preempt', {
            path: 'chat-main-plain',
            signalKind: signal.kind,
            signalId: signal.id,
            strippedSpecs: optionalSpecs.length,
          });
        }
        optionalSpecs = [];
      }
    }
    const turnStreamRuntime = deps.createTurnStreamRuntime(assistantStart);
    const { searchPlannerState } = deps.runTurnPrelude(userText);

    deps.armAcpTurnRef({
      abortCtrl,
      userText,
      turnProfile,
      searchPlannerState,
      optionalSpecs,
    });

    if (finishIfAborted()) return;
    const streamResult = await runDashboardPlainTurnStream({
      userText,
      abortCtrl,
      acpSession: deps.acpSession,
      onText: (chunk, accumulated) => {
        turnStreamRuntime.onText(chunk, accumulated);
      },
      onToolCall: (call) => {
        turnStreamRuntime.onToolCall(call);
        assistantStart = turnStreamRuntime.getAssistantStart();
      },
      onToolResult: (call) => {
        turnStreamRuntime.onToolResult(call);
        assistantStart = turnStreamRuntime.getAssistantStart();
      },
      onUsage: (usage) => {
        deps.runTurnUsageRuntime(usage);
      },
      autoTts: deps.autoTts,
      voiceChat: deps.voiceChat,
      drainCooldownMs: userConfig.voice.tts.drainCooldownMs,
      resetTurnRef: deps.resetAcpTurnRef,
    });
    const fullResponse = streamResult.fullResponse;

    if (debug.enabled) {
      debug.log('dashboard.chat.stream', 'plain-turn.stream-end', {
        fullResponseChars: fullResponse.length,
        chatLinesLen: deps.chatLines.length,
        assistantStart,
        settled: streamResult.settled,
      });
    }

    finalStatus = deps.finalizeStreamLifecycle(
      cleanupEsc,
      abortCtrl.signal.aborted,
      finalStatus,
    );

    await deps.recordTurnMetrics(fullResponse);
    const beforeCommit = deps.chatLines.length;
    deps.applyAssistantRenderState(
      deps.commitAssistantRenderState(fullResponse, assistantStart, deps.chatLines.length),
    );
    if (debug.enabled) {
      debug.log('dashboard.chat.stream', 'plain-turn.commit-render-state', {
        fullResponseChars: fullResponse.length,
        chatLinesBefore: beforeCommit,
        chatLinesAfter: deps.chatLines.length,
        assistantStart,
        chatLinesMutated: beforeCommit !== deps.chatLines.length,
      });
    }

    await deps.runTailAutoCopy(userText, fullResponse);
    await deps.runCodeEditPostTurn();

    await deps.runHandoffMirror(
      typeof userMsg.content === 'string' ? userMsg.content : '',
      fullResponse,
    );

    const action = deps.parseActionBlock(fullResponse);
    if (action) {
      try {
        const anyAction = action as any;
        if (deps.isBrowseMode() && (anyAction.select || anyAction.mode || anyAction.run)) {
          deps.enterSyncMode();
        }
        const outcome = deps.applyActionBlock(action, deps.sync);
        await deps.runActionEffects(outcome);
      } catch {
        deps.pushChatLine(deps.warningLine('Failed to parse action block'));
      }
    }
    const routeFooter = deps.routeFooter?.();
    if (routeFooter) deps.chatFooterLine.current = routeFooter;
  } catch (err: any) {
    finalStatus = 'failed';
    const detail = selectDashboardChatErrorDetail(err);
    const firstLine = detail.split(/\r?\n/, 1)[0]?.trim() ?? '';
    finalError = detail === ''
      ? err?.message || String(err)
      : firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine;
    deps.pushErrorLine(detail);
  } finally {
    try {
      cleanupEsc();
    } finally {
      deps.finalizeTurn(finalStatus, finalError);
    }
  }
}
