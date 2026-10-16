import type { ThinkingHandle } from '../../thinking-line.js';
import { debug, redactSecretText } from '../../debug/log.js';
import { logTurnThrew } from '../turn-busy-teardown.js';
import type { SubmitTurnIntent } from '../../input/input-intent.js';
import type { InputSourceRef } from '../../input/input-source-kind.js';
import { findRecentQuickPassSignal } from '../../input/turn-submit-revision.js';
import type { ControlSignalBus } from '../../input/control-signal.js';
import type { DashboardTurnBlockAttachLike } from '../turn-message-runtime.js';
import type { DashboardAssistantRenderState } from '../turn-tail-runtime.js';
import type { SearchPlannerState } from '../../session-runtime/index.js';
import { runDashboardPlainTurnStream } from './dashboard-plain-turn-stream.js';
import {
  formatFailureNotice, matchFailureText, recordFailureSignatureMatch,
} from '../../self-health/signatures.js';
import { isUnknownCodex400, repairCodexToolPairs, restoreRepairedHistory } from './compact-prepass-recovery.js';
import type { LLMMessage } from '../../llm.js';
import { isTuiRouteLine } from '../../core-turn/short-question.js';

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
    onPrePassApplied: () => void;
  }) => Promise<void>;
  /** Null means the server-side dispatch boundary cannot be observed. */
  readToolDispatchCount?: () => number | null;

  attachChatStreamingKeys: (abortCtrl: AbortController) => () => void;
  /** ⭐ 관측 심 — 형제 `chat-main-entry-runtime` 과 «같은 형태»다(재발명 0 · `OBS-T124`). */
  debugLog?: (category: string, event: string, payload: Record<string, unknown>, opts?: { level?: 'warn' }) => void;
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
  /** 실패 지문이 맞은 오류: 화면엔 한국어 처방 한 줄, 원문은 여기(`/detail`)로. 없으면 원문을 그대로 낸다. */
  pushFailureNotice?: (notice: string, raw: string) => void;
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
  let stage = 'streaming-keys-attached';

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
    const startedAtDate = new Date(deps.turnStartedAt);
    const turnStartedAtIso = Number.isFinite(startedAtDate.getTime())
      ? startedAtDate.toISOString()
      : undefined;
    try {
      deps.debugLog?.('chat-main.plain-turn', 'streaming-keys-attached', {
        userTextBytes: Buffer.byteLength(userText ?? '', 'utf8'),
        turnStartedAt: deps.turnStartedAt,
        turnStartedAtIso,
      });
    } catch { /* fail-soft — 관측이 턴을 막지 않는다 */ }
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
    // Detect whether the pre-pass actually replaced history before considering
    // a bounded pair repair. The copy is never replayed to the provider.
    const beforeCompact = deps.chat.history.slice();

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

    let prePassApplied = false;
    await deps.runAutoCompact({
      preamble,
      chatHistory: deps.chat.history,
      userMsg,
      onPrePassApplied: () => { prePassApplied = true; },
    });
    const compactChanged = prePassApplied && (deps.chat.history.length !== beforeCompact.length
      || deps.chat.history.some((message, index) => message !== beforeCompact[index]));
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
    // TUI-FIRST-TURN-STALL — 09:48 표본에서 llm.stream consume-start 뒤
    // first-token 이벤트가 0건이어서 「첫 토큰까지의 구간」을 잴 표면이 없었다.
    // turnStartedAt 를 재사용해 첫 비어 있지 않은 text chunk 에 정확히 한 번
    // chat.turn/first-token 을 남긴다. 도구 호출이 먼저 흘러도 text 가 도착해야
    // 기록되므로 request→first-token 구간은 그대로 측정된다. ISO 시각 좌표는
    // pty record 및 TUI-BOOT-TIME(src/index.ts) 부팅 계측과의 대응용이다.
    let firstTokenLogged = false;
    const logFirstToken = (chunk: string): void => {
      if (firstTokenLogged || !chunk || abortCtrl.signal.aborted) return;
      firstTokenLogged = true;
      const firstTokenAt = Date.now();
      try {
        deps.debugLog?.('chat.turn', 'first-token', {
          ms: firstTokenAt - deps.turnStartedAt,
          turnStartedAt: deps.turnStartedAt,
          turnStartedAtIso,
          firstTokenAtIso: new Date(firstTokenAt).toISOString(),
        });
      } catch { /* fail-soft — 관측이 턴을 막지 않는다 */ }
    };
    const recoverySend: typeof deps.acpSession = {
      send: async (opts) => {
        let lastError: unknown;
        let pairReport: ReturnType<typeof repairCodexToolPairs> | null = null;
        let inspectedHistory: string | null = null;
        let initialAttemptEmitted = false;
        let warned = false;
        const manualRecovery = (reason: string): void => {
          if (warned) return;
          warned = true;
          deps.debugLog?.('chat.compact-400-recovery', 'manual-recovery-required', {
            reason, historyMessages: deps.chat.history.length,
          });
          deps.pushChatLine(deps.warningLine(
            'Codex 400으로 자동 복구를 멈췄습니다. 대화 이력을 확인한 뒤 /session new 로 새 세션을 시작하세요.',
          ));
        };
        const dispatchCountBeforeSend = deps.readToolDispatchCount?.() ?? null;
        const attempt = async (stage: string): Promise<boolean> => {
          let emitted = false;
          try {
            await deps.acpSession.send({
              ...opts,
              // 라우팅 줄은 브리지가 모델 호출 «전»에 보낸다 — 모델 출력이 아니므로 재시도를 막지 않는다.
              onText: (chunk) => {
                if (!isTuiRouteLine(chunk)) { emitted = true; if (stage === 'initial') initialAttemptEmitted = true; }
                opts.onText(chunk);
              },
              onToolCall: (call) => { emitted = true; if (stage === 'initial') initialAttemptEmitted = true; opts.onToolCall(call); },
              onToolResult: (call) => { emitted = true; if (stage === 'initial') initialAttemptEmitted = true; opts.onToolResult(call); },
            });
            deps.debugLog?.('chat.compact-400-recovery', 'recovered', { stage });
            return true;
          } catch (err) {
            const dispatchCountNow = deps.readToolDispatchCount?.() ?? null;
            const dispatchUnknown = dispatchCountBeforeSend === null || dispatchCountNow === null;
            const toolDispatched = dispatchCountNow !== dispatchCountBeforeSend;
            const unknown400 = isUnknownCodex400(selectDashboardChatErrorDetail(err), err);
            if (unknown400 && compactChanged) {
              if (!pairReport) {
                pairReport = repairCodexToolPairs(deps.chat.history as LLMMessage[]);
                try { inspectedHistory = JSON.stringify(deps.chat.history); } catch { /* unsafe to retry */ }
                deps.debugLog?.('chat.compact-400-recovery', 'pair-check', {
                  removedCalls: pairReport.removedCalls,
                  removedResults: pairReport.removedResults,
                  ambiguousCount: pairReport.ambiguousIds.length,
                  readOnly: true,
                });
              }
              deps.debugLog?.('chat.compact-400-recovery', 'codex-400-unknown', {
                stage, historyMessages: deps.chat.history.length,
                emitted, dispatchUnknown, toolDispatched,
              });
            }
            if (emitted || dispatchUnknown || toolDispatched || abortCtrl.signal.aborted || !compactChanged
              || !unknown400) {
              if (stage === 'pair-repair') manualRecovery('pair-repair-failed');
              else if (unknown400 && compactChanged) manualRecovery('unsafe-retry');
              throw err;
            }
            lastError = err;
            return false;
          }
        };
        if (await attempt('initial')) return;

        const repaired = pairReport!;
        let historyUnchanged = false;
        try {
          historyUnchanged = inspectedHistory !== null
            && JSON.stringify(deps.chat.history) === inspectedHistory;
        } catch { /* unsafe to retry */ }
        if (!historyUnchanged) {
          deps.debugLog?.('chat.compact-400-recovery', 'history-changed-after-pair-check', {
            historyMessages: deps.chat.history.length,
          });
          manualRecovery('history-changed-after-pair-check');
          throw lastError;
        }
        if (repaired.ambiguousIds.length === 0 && repaired.removedCalls + repaired.removedResults > 0) {
          let beforeRepairValues: typeof deps.chat.history;
          let expectedRepairedValues: typeof repaired.messages;
          try {
            beforeRepairValues = structuredClone(deps.chat.history);
            expectedRepairedValues = structuredClone(repaired.messages);
          } catch {
            manualRecovery('history-snapshot-unavailable');
            throw lastError;
          }
          const dispatchCountBeforeRepair = deps.readToolDispatchCount?.() ?? null;
          let historyStillInspected = false;
          try {
            historyStillInspected = inspectedHistory !== null
              && JSON.stringify(deps.chat.history) === inspectedHistory;
          } catch { /* unsafe to retry */ }
          if (dispatchCountBeforeSend === null || dispatchCountBeforeRepair === null
            || dispatchCountBeforeRepair !== dispatchCountBeforeSend
            || initialAttemptEmitted || abortCtrl.signal.aborted || !historyStillInspected) {
            deps.debugLog?.('chat.compact-400-recovery', 'retry-gate-changed', {
              dispatchUnknown: dispatchCountBeforeSend === null || dispatchCountBeforeRepair === null,
              toolDispatched: dispatchCountBeforeRepair !== dispatchCountBeforeSend,
              emitted: initialAttemptEmitted,
              aborted: abortCtrl.signal.aborted,
              historyChanged: !historyStillInspected,
            });
            manualRecovery('retry-gate-changed');
            throw lastError;
          }
          deps.chat.history.splice(0, deps.chat.history.length, ...repaired.messages);
          let recovered = false;
          try {
            recovered = await attempt('pair-repair');
            if (recovered) return;
          } finally {
            if (!recovered) {
              const restoration = restoreRepairedHistory(
                deps.chat.history, beforeRepairValues, repaired.messages, expectedRepairedValues,
              );
              deps.debugLog?.('chat.compact-400-recovery', restoration.restored
                ? 'history-restored' : 'history-restore-skipped', restoration);
            }
          }
        }

        manualRecovery(repaired.ambiguousIds.length > 0 ? 'ambiguous-tool-pairing'
          : repaired.removedCalls + repaired.removedResults > 0 ? 'pair-repair-failed' : 'no-orphan-pairs');
        throw lastError;
      },
    };
    const streamResult = await runDashboardPlainTurnStream({
      userText,
      abortCtrl,
      acpSession: recoverySend,
      onText: (chunk, accumulated) => {
        logFirstToken(chunk);
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
    const stackHead = typeof err?.stack === 'string'
      ? err.stack.split('\n').slice(0, 4).join('\n')
      : undefined;
    deps.debugLog?.('chat-main.plain-turn', 'turn-failed', {
      stage,
      message: redactSecretText(detail),
      stackHead: stackHead === undefined ? undefined : redactSecretText(stackHead),
    });
    // TUI-STALE-BUSY-MARKER(#58) — 턴 본문 실패도 tui 범주 한 곳(`tui.turn turn-threw`)에서 보인다.
    logTurnThrew(`turn:${stage}`, err, deps.debugLog);
    const firstLine = detail.split(/\r?\n/, 1)[0]?.trim() ?? '';
    finalError = detail === ''
      ? err?.message || String(err)
      : firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine;
    const failure = deps.pushFailureNotice ? matchFailureText(detail) : null;
    if (failure && deps.pushFailureNotice) {
      recordFailureSignatureMatch(failure, 'turn-error');
      finalError = failure.cause;
      deps.pushFailureNotice(formatFailureNotice(failure, { rawHint: '/detail open' }), detail);
    } else {
      deps.pushErrorLine(detail);
    }
    // ⛔ #27452 400 복구 판정은 «원문» detail 로 — 지문 번역(finalError)으로 판정하면 복구가 안 걸린다.
    if (isUnknownCodex400(detail)) {
      // The normal finalizer also stops it, but freezing here closes the
      // failure path even if an outer render callback throws afterward.
      deps.thinking.stop({ status: 'failed', errorText: finalError });
      deps.debugLog?.('chat.compact-400-recovery', 'thinking-stopped', { status: 'failed' });
    }
  } finally {
    try {
      cleanupEsc();
    } finally {
      deps.finalizeTurn(finalStatus, finalError);
    }
  }
}
