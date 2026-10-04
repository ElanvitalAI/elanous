import { classifyShortQuestion } from '../chat/short-question.js';
import { getUserConfig } from '../user-config.js';
import { runCoreTurn } from '../core-turn/index.js';
import type { LLMMessage, LLMToolSpec } from '../llm.js';
import { maybeImageBearingResult } from '../llm.js';
import { notifyAgentTurnEnd } from '../web-push/notify-turn-end.js';
import {
  appendAssistantMessages,
  appendUserAndBuildMessages,
  appendUserPromptBlocksAndBuildMessages,
} from './daemon-history-helper.js';
import type { ContentBlock as AcpContentBlock } from '@agentclientprotocol/sdk';
import { personaPromptForChat, type DaemonSessionHistory } from './daemon-runtime.js';
import type { DaemonPromptRequest } from './daemon-prompt-request.js';
import type { DaemonToolSurface } from './daemon-tools/types.js';
import type { ConfirmChannel } from '../hitl/confirm.js';
import type { QuestionChannel } from '../hitl/question.js';
import type { SurfaceKind } from '../agent/surface-ux/types.js';
import {
  resolveSurfaceKindFromInputSource,
  type SurfaceKindResolutionReason,
} from '../agent/surface-ux/from-input-source.js';
import { debug } from '../debug/log.js';
import { appendWebtermContext } from './daemon-tools/webterm-context.js';
import { buildTerminalCapableTurn } from '../agent/terminal-surface.js';
import { PTY_SHELL_TOOL_NAMES } from './daemon-tools/pty-shell.js';
import { createToolCwdResolver } from './tool-cwd.js';

export interface DaemonPromptTurnResult {
  sessionId: string;
  text: string;
  stopReason: string;
}

/** Phase B-3 (PWA chat streaming · 2026-05-06) — derive a one-line
 *  human-readable summary from a tool result for the SSE
 *  `tool-result` event. Returns `undefined` when nothing useful can
 *  be said (caller writes a bare done pill). The shape switch covers
 *  the conventions actually produced by `tool-runtime/*` dispatchers:
 *
 *  - image-bearing (`{mediaType, dataB64, ...}`) → `image/png 12.4 KB`
 *  - text-output (`{output: string}`) → first 80 chars trimmed
 *  - matches array (`{matches: [...]}`) → `${count} matches`
 *  - lines array (`{lines: [...]}`) → `${count} lines`
 *  - other object → field count
 *  - string → first 80 chars trimmed
 *  - other → `typeof` label
 *
 *  Exported for unit testing. */
export function summarizeToolResult(result: unknown): string | undefined {
  if (result == null) return undefined;
  if (typeof result === 'string') {
    const trimmed = result.trim().split('\n')[0] ?? '';
    return trimmed.slice(0, 80) + (trimmed.length > 80 ? '…' : '');
  }
  if (typeof result !== 'object') return typeof result;
  const o = result as Record<string, unknown>;
  // image-bearing: report mime + size estimate
  if (typeof o.mediaType === 'string' && typeof o.dataB64 === 'string') {
    const kb = Math.round((o.dataB64.length * 3) / 4 / 1024);
    return `${o.mediaType} ~${kb} KB`;
  }
  // matches array (Grep)
  if (Array.isArray(o.matches)) return `${o.matches.length} matches`;
  // lines array (Read pagination)
  if (Array.isArray(o.lines)) return `${o.lines.length} lines`;
  // entries array (List)
  if (Array.isArray(o.entries)) return `${o.entries.length} entries`;
  // text output
  if (typeof o.output === 'string') {
    const first = o.output.trim().split('\n')[0] ?? '';
    return first.slice(0, 80) + (first.length > 80 ? '…' : '');
  }
  if (typeof o.text === 'string') {
    const first = o.text.trim().split('\n')[0] ?? '';
    return first.slice(0, 80) + (first.length > 80 ? '…' : '');
  }
  if (typeof o.runId === 'string' && o.runId) {
    return `run ${o.runId} — elanous self run ${o.runId}`;
  }
  // generic: count fields so the pill shows something
  const keys = Object.keys(o);
  return keys.length > 0 ? `${keys.length} field${keys.length === 1 ? '' : 's'}` : undefined;
}

export async function runDaemonPromptTurn(opts: {
  history: DaemonSessionHistory;
  /** B1 빠른 경로 스위치 — 없으면 config `chat.fastPath`(기본 true). 시험·호출부가 못 박을 때만 준다. */
  fastPathEnabled?: boolean;
  request: DaemonPromptRequest;
  /** Optional multimodal prompt blocks for the current user turn.
   *  When present, history persistence keeps the ACP block shape
   *  instead of collapsing everything to plain text. */
  promptBlocks?: readonly AcpContentBlock[];
  /** Active LLM tool surface. When provided, the LLM receives the
   *  spec list + a dispatcher routed through the surface — tool calls
   *  flow normally and image-bearing results (P1 #1631) wire through.
   *  When omitted (or kind='none'), the legacy text-only behavior
   *  applies: tools=[], dispatchTool throws with the supplied error
   *  message. Wired in 2026-05-05 to fix `/v1/prompt` ignoring the
   *  daemon's `--tools webterm` activation that ACP WS already
   *  honored via `createDaemonRunTurn`. */
  toolSurface?: DaemonToolSurface;
  /** Triggering chat surface, resolved from the request input source. */
  surface?: SurfaceKind;
  /** Resolution outcome retained for the per-turn observability event. */
  surfaceResolutionReason?: SurfaceKindResolutionReason;
  /** Optional confirm channels for the triggering chat surface. */
  surfaceHitlChannels?: ConfirmChannel[];
  /** Server-authenticated human owner for this request; absent for delegated or unverified callers. */
  verifiedOwner?: { id: string };
  /** Optional structured-question channels for the triggering chat surface. */
  surfaceQuestionChannels?: QuestionChannel[];
  /** CWD for fs-bound tool dispatch (Read / Grep). Defaults to
   *  `process.cwd()` when omitted; pair with the daemon's
   *  `--tool-cwd` / `ELANOUS_TOOL_CWD` to keep `/v1/prompt` and ACP WS
   *  on the same path-guard boundary. */
  toolCwd?: string;
  /** Per-turn project instructions; unlike the base system preamble these must survive subsequent turns. */
  projectInstructions?: string;
  /** Phase 4 (WT-A-3b) — external abort signal. When provided and
   *  fired, the internal AbortController fans the abort through to
   *  `runCoreTurn` (LLM stream + tool dispatch). Callers without an
   *  external signal still get the implicit per-turn controller —
   *  this is purely a hook for sticky-REPL `:agent` Esc cancellation
   *  and similar caller-driven aborts. */
  signal?: AbortSignal;
  /** Phase B-1 (PWA chat streaming · 2026-05-06) — text delta hook.
   *  Forwarded to `runCoreTurn.callbacks.onText`; PWA `/v1/prompt/stream`
   *  uses this to push SSE `text-delta` events. Default callers omit it
   *  and the turn loop runs unchanged. `delta` is the new fragment;
   *  `full` is the cumulative assistant text up to and including it. */
  onTextDelta?: (delta: string, full: string) => void;
  /** Phase B-2.5 (PWA chat streaming · 2026-05-06) — tool-result image
   *  hook. Fires once per resolved tool call whose result follows the
   *  image-bearing convention (`{mediaType: 'image/…', dataB64, …}`,
   *  detected via `maybeImageBearingResult`). The PWA `/v1/prompt/stream`
   *  handler uses this to push SSE `image-block` events so screenshots
   *  + camera frames + chart renders surface inline in `/chat`. `src`
   *  is a renderable `data:` URI built from the tool result; `alt` is
   *  defaulted to `${toolName} result` for accessibility. Default
   *  callers omit this and the turn runs unchanged. */
  onImageBlock?: (info: { src: string; mediaType: string; alt?: string }) => void;
  /** Phase B-3 (PWA chat streaming · 2026-05-06) — tool lifecycle
   *  hooks. `onToolCall` fires just before dispatch (status pill
   *  shows "running"); `onToolResultMeta` fires once the tool
   *  resolves (status flips to done/error + a 1-line summary). PWA
   *  `/v1/prompt/stream` writes these as SSE `tool-call` /
   *  `tool-result` events so the user sees the agent's tool loop in
   *  real time instead of a silent placeholder spinner. The image
   *  surface (B-2.5 above) and the meta surface coexist: a single
   *  resolved call can fire BOTH `onImageBlock` and
   *  `onToolResultMeta`. */
  onToolCall?: (info: {
    id: string;
    name: string;
    args: Record<string, unknown>;
  }) => void;
  onToolResultMeta?: (info: {
    id: string;
    name: string;
    ok: boolean;
    summary?: string;
    result?: unknown;
  }) => void;
  /** M5 PR 2 (PLAN-rich-dev-feedback-multi-surface · 2026-05-13) —
   *  optional FeedbackEnvelope emitter. Threaded into
   *  DaemonToolDispatchCtx.emitFeedback so progressive runtimes (Grep
   *  search-hits, future Read large-file progress) can stream
   *  envelopes back to PWA / TUI / iOS chat surfaces. handlePromptStreamPost
   *  passes its `dualEmitFeedback` closure here; legacy callers omit. */
  onFeedback?: (env: import('../feedback/envelope.js').FeedbackEnvelope) => void;
  dispatchToolErrorMessage: string;
}): Promise<DaemonPromptTurnResult> {
  const { history, request, toolSurface, dispatchToolErrorMessage } = opts;
  const sourceResolution = resolveSurfaceKindFromInputSource(request.source);
  const surface = opts.surface ?? sourceResolution.surface;
  const surfaceResolutionReason = opts.surfaceResolutionReason ?? sourceResolution.reason;
  debug.log('daemon-prompt-turn', 'surface-resolved', {
    surface,
    reason: surfaceResolutionReason,
    hasUserText: request.userText.length > 0,
  });
  const hasAttachments = (opts.promptBlocks?.length ? opts.promptBlocks : request.userContent)
    ?.some((block) => block.type !== 'text') ?? false;
  // SW2 스위치 `chat.fastPath`(기본 켜짐 · PWA «짧은 물음은 빠르게» 카드) — 끄면 분류하지 않는다.
  const fastPathEnabled = opts.fastPathEnabled ?? (() => { try { return getUserConfig().chat?.fastPath !== false; } catch { return true; } })();
  const { fast, reason } = fastPathEnabled
    ? classifyShortQuestion(request.userText, { hasAttachments })
    : { fast: false, reason: 'disabled' };
  const activeToolSurface = fast ? undefined : toolSurface;
  const toolsBefore = toolSurface && toolSurface.kind !== 'none' ? toolSurface.specs.length : 0;
  const tools: LLMToolSpec[] = activeToolSurface && activeToolSurface.kind !== 'none'
    ? activeToolSurface.specs
    : [];
  debug.log('chat.fast-path', 'decided', { fast, reason, toolsBefore, toolsAfter: tools.length });
  // Image-pipeline followup #4 (2026-05-05) — when the webterm surface
  // is active, prepend a daemon-context block ("Current ACP sessionId:
  // …" + active terminals) to the system prompt so the LLM has the
  // session id + terminal ids without an extra discovery call. Helper
  // returns the original prompt unchanged when there's nothing to add.
  const personaPrompt = await personaPromptForChat(request.personaId);
  const augmentedSystemPrompt = appendWebtermContext(
    personaPrompt ? [personaPrompt, request.effectiveSystemPrompt].filter(Boolean).join('\n\n') : request.effectiveSystemPrompt,
    request.sessionId,
    activeToolSurface,
  );
  const ctrl = new AbortController();
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort();
    else opts.signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  const toolCwdResolver = createToolCwdResolver({
    tools: activeToolSurface?.kind ?? 'none',
    ...(opts.toolCwd !== undefined ? { toolCwd: opts.toolCwd } : {}),
  });
  const rawDispatchTool = activeToolSurface && activeToolSurface.kind !== 'none'
    ? async (name: string, args: Record<string, unknown>, perCallCtx?: { callId: string }): Promise<unknown> => {
        const dispatchCtrl = new AbortController();
        const onAbort = (): void => dispatchCtrl.abort();
        ctrl.signal.addEventListener('abort', onAbort);
        try {
          // Image-pipeline followup #1 (2026-05-05) — pass the current
          // request.sessionId through so WebTerminal* tools can auto-
          // resolve scope when the LLM omits sessionId from args.
          return await activeToolSurface.dispatch(name, args, {
            cwd: toolCwdResolver.cwd!,
            resolveWriteCwd: toolCwdResolver.resolveWriteCwd,
            signal: dispatchCtrl.signal,
            sessionId: request.sessionId,
            ...(request.source?.kind === 'daemon-api' && request.source.route === '/a2a'
              ? { requestOrigin: 'external-agent' as const } : {}),
            ...(request.userText ? { userText: request.userText } : {}),
            ...(opts.verifiedOwner ? { verifiedOwner: opts.verifiedOwner } : {}),
            ...(opts.surface !== undefined || sourceResolution.surface !== 'unknown' ? { surface } : {}),
            ...(opts.surfaceHitlChannels ? { surfaceHitlChannels: opts.surfaceHitlChannels } : {}),
            ...(opts.surfaceQuestionChannels ? { surfaceQuestionChannels: opts.surfaceQuestionChannels } : {}),
            ...(perCallCtx?.callId !== undefined ? { toolCallId: perCallCtx.callId } : {}),
            // Elanous's own LLM assembles tool arguments from natural language.
            entry: 'elanous-apparatus',
            // M5 PR 2 — thread the FeedbackEnvelope emitter so
            // progressive tools (Grep · future Read) push hit/progress
            // envelopes back to chat surfaces. Absent when caller didn't
            // supply onFeedback (skill / CLI path).
            ...(opts.onFeedback ? { emitFeedback: opts.onFeedback } : {}),
          });
        } finally {
          ctrl.signal.removeEventListener('abort', onAbort);
        }
      }
    : async (): Promise<unknown> => {
        throw new Error(dispatchToolErrorMessage);
      };
  // PLAN-multi-surface-pty-shell M3 — when the surface exposes the
  // PtyShell family, fold the shared terminal adapters onto this turn:
  // budgetGrant (loop rounds while driving a terminal), abort→PTY kill,
  // `_imageFile`→inline `{mediaType,dataB64}` (onImageBlock forwards to
  // PWA/iOS/Android; vision LLMs see the frame), mission discipline.
  const terminal = tools.some((t) => (PTY_SHELL_TOOL_NAMES as readonly string[]).includes(t.name))
    ? buildTerminalCapableTurn({
        specs: tools,
        dispatch: rawDispatchTool,
        systemPromptParts: augmentedSystemPrompt ? [augmentedSystemPrompt] : [],
        signal: ctrl.signal,
        inlineImages: true,
      })
    : null;
  const dispatchTool = terminal ? terminal.dispatch : rawDispatchTool;
  const fastPathGuidance = '확인이 필요하면 "확인해 볼까요?" 한 줄로 끝낸다';
  const effectiveSystemPrompt = fast
    ? [augmentedSystemPrompt, fastPathGuidance].filter(Boolean).join('\n')
    : terminal
      ? terminal.systemPromptParts.join('\n\n')
      : augmentedSystemPrompt;
  const isFirstTurn = history.get(request.sessionId).length === 0;
  const messages = opts.promptBlocks && opts.promptBlocks.length > 0
    ? appendUserPromptBlocksAndBuildMessages(
        history,
        request.sessionId,
        opts.promptBlocks,
        effectiveSystemPrompt,
      )
    : appendUserAndBuildMessages(
        history,
        request.sessionId,
        request.userText,
        effectiveSystemPrompt,
      );
  if (fast && !isFirstTurn) {
    messages.unshift({ role: 'system', content: fastPathGuidance });
  }
  if (!isFirstTurn && opts.projectInstructions) {
    messages.unshift({ role: 'system', content: opts.projectInstructions });
  }
  if (!isFirstTurn && personaPrompt) {
    messages.unshift({ role: 'system', content: personaPrompt });
  }
  const result = await runCoreTurn({
    sessionId: request.sessionId,
    userText: request.userText,
    messages,
    tools,
    dispatchTool,
    signal: ctrl.signal,
    ...(terminal?.llmOpts.budgetGrant ? { budgetGrant: terminal.llmOpts.budgetGrant } : {}),
    callbacks: {
      onTurnComplete: (newMessages: LLMMessage[]): void => {
        appendAssistantMessages(history, request.sessionId, newMessages);
      },
      ...(opts.onTextDelta
        ? {
            onText: (delta: string, full: string): void => {
              opts.onTextDelta!(delta, full);
            },
          }
        : {}),
      ...(opts.onToolCall
        ? {
            onToolCall: (call): void => {
              try {
                opts.onToolCall!({
                  id: call.id,
                  name: call.name,
                  args: call.args,
                });
              } catch {
                /* swallow — status pill is supplemental */
              }
            },
          }
        : {}),
      ...(opts.onImageBlock || opts.onToolResultMeta
        ? {
            onToolResult: (call): void => {
              // Phase B-2.5 — image-bearing convention forwards via
              // `maybeImageBearingResult` (the same detector
              // `streamLLMWithTools` uses to repackage results for
              // vision-capable LLMs). Phase B-3 adds the meta surface:
              // every resolved call fires `onToolResultMeta` with a
              // 1-line summary so the chat pill flips from running →
              // done. Both surfaces are wrapped in a single try so a
              // bad summary derivation can't break the image push.
              try {
                if (opts.onImageBlock) {
                  const imageBearing = maybeImageBearingResult(call.result);
                  if (imageBearing) {
                    const src = `data:${imageBearing.mediaType};base64,${imageBearing.dataB64}`;
                    opts.onImageBlock({
                      src,
                      mediaType: imageBearing.mediaType,
                      alt: `${call.name} result`,
                    });
                  }
                }
                if (opts.onToolResultMeta) {
                  const summary = summarizeToolResult(call.result);
                  opts.onToolResultMeta({
                    id: call.id,
                    name: call.name,
                    ok: true,
                    ...(summary !== undefined ? { summary } : {}),
                    ...(call.result !== undefined ? { result: call.result } : {}),
                  });
                }
              } catch {
                /* swallow — pill / image dispatch are supplemental */
              }
            },
          }
        : {}),
    },
  });
  // Cleanup PR — fire Web Push to subscribed PWA clients ("agent done").
  // Fire-and-forget: turn already succeeded, push failure must not block
  // the REST response. Helper handles aborted/empty-text early-return.
  void notifyAgentTurnEnd({
    sessionId: request.sessionId,
    finalText: result.finalText,
    stopReason: result.stopReason,
  });
  return {
    sessionId: request.sessionId,
    text: result.finalText,
    stopReason: result.stopReason,
  };
}
