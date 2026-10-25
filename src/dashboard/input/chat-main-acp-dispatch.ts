import type { NormalizedAttachment } from '../../acp/content-blocks.js';
import { debug } from '../../debug/log.js';
import type { ControlSignalBus } from '../../input/control-signal.js';
import { classifyInterimReply, formatInterimFoldLine } from '../../tui/chat/goal-interim.js';
import {
  createTurnOutputBundle,
  runTurnOutputBundleSettle,
} from '../../input/turn-output-bundle.js';
import {
  displayBackendName,
  type AcpBackendId,
  type AcpChatHandlers,
} from '../chat/acp-chat.js';

export interface DashboardChatMainAcpDispatchDeps {
  dashboardAcpChat: {
    send: (
      backend: AcpBackendId,
      message: string,
      handlers: AcpChatHandlers,
      attachments?: NormalizedAttachment[],
    ) => Promise<void>;
  };
  backend: AcpBackendId;
  message: string;
  attachments: NormalizedAttachment[];
  debugEnabled: boolean;
  chatLines: string[];
  setChatScrollToTail: () => void;
  redraw: () => void;
  formatAssistantLines: (text: string) => string[];
  formatUserLine: (display: string, message: string) => string;
  formatMutedLine: (line: string) => string;
  formatToolLine: (tool: string) => string;
  formatDebugLine: (display: string, reason: string, chars: number) => string;
  formatErrorLine: (display: string, message: string) => string;
  formatAssistantPrefix: (display: string) => string;
  /** Phase 2 auto-TTS — when present, every assistant chunk is also
   *  forwarded to the auto-TTS controller and onDone/onError trigger
   *  commit/cancel. Optional; when absent the dispatch behaves exactly
   *  as before (zero diff in the no-auto-TTS path). */
  autoTtsHooks?: {
    pushChunk: (delta: string) => void;
    commit: () => void | Promise<void>;
    cancel: () => void | Promise<void>;
  };
  /** Generic turn-end hook — fires after onDone or onError regardless
   *  of whether auto-TTS is wired. Voice-chat continuous mode wires
   *  this to `controller.notifyResponseDone()` so the speaking phase
   *  drops to inactive (or restarts listening, in multi-turn mode)
   *  even when ELANOUS_AUTO_TTS is off. Without this hook the
   *  controller stayed in `speaking` indefinitely on turn-end and
   *  the user had to ESC out — which then closed the STT WebSocket
   *  with code 1000, surfaced as a false-alarm error.
   *
   *  Reason values mirror onDone's stop reason / 'error' / 'cancelled'. */
  onTurnDone?: (reason: 'end_turn' | 'error' | 'cancelled') => void;
  /** Drain cooldown (ms) inserted between auto-TTS commit/cancel and
   *  the `onTurnDone` callback. Without this gap the voice-chat
   *  controller flips `speaking → listening` while the OS audio
   *  queue still has a tail of TTS playback, and the mic re-captures
   *  the assistant's voice → echo loop into STT. Range 0–2000.
   *  Defaults to 0 when omitted (no cooldown). User-config is the
   *  canonical source: `voice.tts.drainCooldownMs`. */
  drainCooldownMs?: number;
  signalBus?: ControlSignalBus;
}

export function dispatchDashboardChatMainAcpSend(
  deps: DashboardChatMainAcpDispatchDeps,
): void {
  const display = displayBackendName(deps.backend);
  deps.chatLines.push(deps.formatUserLine(display, deps.message));
  deps.setChatScrollToTail();

  let accumulated = '';
  let firstChunk = true;
  let assistantTextActive = false;
  let assistantBodyStart = -1;
  let assistantBodyEnd = -1;
  const interimBodyRanges: Array<{ start: number; end: number }> = [];
  let assistantBodyText = '';
  let assistantRunUsesPrefix = false;

  void deps.dashboardAcpChat.send(deps.backend, deps.message, {
    pushLine: (line) => {
      deps.chatLines.push(deps.formatMutedLine(line));
      deps.setChatScrollToTail();
      assistantTextActive = false;
    },
    appendChunk: (delta) => {
      if (!assistantTextActive) {
        assistantRunUsesPrefix = firstChunk;
        if (firstChunk) firstChunk = false;
        assistantBodyText = '';
        assistantBodyStart = -1;
        assistantBodyEnd = -1;
        assistantTextActive = true;
      }
      assistantBodyText += delta;
      accumulated += delta;
      // SCHEME-debug-logging — auto-TTS dispatch trail. Lets us tell
      // whether assistant chunks are reaching the TTS hook at all
      // (the "speaking phase but no audio" symptom usually traces
      // here: either appendChunk never fires, or autoTtsHooks is
      // undefined for this dispatch path).
      if (debug.enabled)
        debug.log('voice.auto-tts', 'dispatch.chunk', {
          chars: delta.length,
          hasHook: !!deps.autoTtsHooks,
          accumulated: accumulated.length,
          backend: deps.backend,
        });
      deps.autoTtsHooks?.pushChunk(delta);
      const rendered = deps.formatAssistantLines(assistantBodyText);
      if (assistantBodyStart < 0) assistantBodyStart = deps.chatLines.length;
      deps.chatLines.splice(assistantBodyStart, Math.max(0, assistantBodyEnd - assistantBodyStart));
      rendered.forEach((line, index) => {
        if (index === 0 && assistantRunUsesPrefix) {
          deps.chatLines.push(`${deps.formatAssistantPrefix(display)} ${line}`);
        } else {
          deps.chatLines.push(`  ${line}`);
        }
      });
      assistantBodyEnd = assistantBodyStart + rendered.length;
      if (interimBodyRanges.at(-1)?.start === assistantBodyStart) interimBodyRanges[interimBodyRanges.length - 1]!.end = assistantBodyEnd;
      else interimBodyRanges.push({ start: assistantBodyStart, end: assistantBodyEnd });
      deps.setChatScrollToTail();
    },
    foldGoalInterim: (text) => {
      const verdict = classifyInterimReply(text.split('\n'));
      if (verdict.interim && interimBodyRanges.length > 0) {
        const first = interimBodyRanges[0]!.start;
        for (const { start, end } of [...interimBodyRanges].reverse()) deps.chatLines.splice(start, end - start);
        deps.chatLines.splice(first, 0, `  ${formatInterimFoldLine(verdict.summary)}`);
        deps.setChatScrollToTail();
      }
      interimBodyRanges.length = 0;
      assistantTextActive = false;
      assistantBodyStart = -1;
      assistantBodyEnd = -1;
    },
    pushToolCall: (tool) => {
      deps.chatLines.push(deps.formatToolLine(tool));
      deps.setChatScrollToTail();
      assistantTextActive = false;
    },
    onDone: (reason) => {
      if (deps.debugEnabled) {
        deps.chatLines.push(deps.formatDebugLine(display, reason, accumulated.length));
      }
      deps.setChatScrollToTail();
      deps.redraw();
      if (debug.enabled)
        debug.log('voice.auto-tts', 'dispatch.commit.begin', {
          reason,
          accumulated: accumulated.length,
          hasHook: !!deps.autoTtsHooks,
          backend: deps.backend,
        });
      // 2026-04-30 — Sync turn-end with the audio sink. Previously
      // `commit()` was fire-and-forget and `onTurnDone` fired
      // synchronously after the LLM stream ended → voice-chat
      // controller flipped to `listening` while TTS playback was
      // still going (4-9s late on real turns), causing the
      // microphone to pick up the assistant's own voice and feed
      // it back into STT (echo loop). Now: await commit (drains
      // sox `play`), then fire onTurnDone — `speaking → listening`
      // happens AFTER the speaker is silent.
      //
      // Full sink-flavor synchronization (text + audio + fan-out
      // + hud) is tracked in
      // BACKLOG-voice-chat-multi-turn-plain-dispatch-extract §9.
      const settledReason: 'end_turn' | 'cancelled' = reason === 'end_turn' ? 'end_turn' : 'cancelled';
      const cooldownMs = deps.drainCooldownMs ?? 0;
      void (async () => {
        await runTurnOutputBundleSettle({
          bundle: createTurnOutputBundle([
            {
              kind: 'audio-tts',
              lifecycle: 'segment-stream-then-drain',
              onEndTurn: async () => { await deps.autoTtsHooks?.commit(); },
              onCancel: async () => { await deps.autoTtsHooks?.cancel(); },
            },
          ]),
          settled: settledReason,
          cooldownMs,
          notifyDone: deps.onTurnDone ? (reason) => deps.onTurnDone?.(reason) : undefined,
          debugPath: 'acp',
          ...(deps.signalBus ? {
            preSettleQuickPass: {
              signalBus: deps.signalBus,
              scope: { surface: 'voice-chat', channel: 'dashboard' },
              signalKinds: ['voice-chat-stop', 'turn-submit-preempt-output'],
            },
          } : {}),
        });
      })();
    },
    onError: (err) => {
      deps.chatLines.push(deps.formatErrorLine(display, err.message));
      deps.setChatScrollToTail();
      deps.redraw();
      if (debug.enabled)
        debug.log('voice.auto-tts', 'dispatch.cancel.begin', {
          err: err.message,
          accumulated: accumulated.length,
          hasHook: !!deps.autoTtsHooks,
          backend: deps.backend,
        });
      // Same sink sync as onDone — cancel kills sox NOW, but await
      // it before flipping the controller so any short tail doesn't
      // overlap with the next listening window.
      const cooldownMs = deps.drainCooldownMs ?? 0;
      void (async () => {
        await runTurnOutputBundleSettle({
          bundle: createTurnOutputBundle([
            {
              kind: 'audio-tts',
              lifecycle: 'segment-stream-then-drain',
              onEndTurn: async () => { await deps.autoTtsHooks?.commit(); },
              onCancel: async () => { await deps.autoTtsHooks?.cancel(); },
            },
          ]),
          settled: 'error',
          cooldownMs,
          notifyDone: deps.onTurnDone ? (reason) => deps.onTurnDone?.(reason) : undefined,
          debugPath: 'acp',
        });
      })();
    },
    redraw: deps.redraw,
  }, deps.attachments);
}
