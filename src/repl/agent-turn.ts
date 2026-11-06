// WT-A-3b — `:agent` LLM-driven runTurn wrapper.
//
// Bridges the sticky-REPL `:agent <prompt>` meta-command to the daemon's
// existing `runDaemonPromptTurn` so the same tool surface, history, and
// system-prompt composition the REST `/v1/prompt` path uses are honored
// for terminal-driven prompts. The wrapper folds in the active web
// terminal's context (visible buffer + cwd + cols×rows) so the LLM
// starts the turn with situational awareness.
//
// Why a thin wrapper rather than a duplicated turn runner: avoids
// drifting from `runDaemonPromptTurn` (which already wires the webterm
// system-prompt block, sessionId auto-injection, and tool dispatch
// gating). The wrapper's only added value is context bundling +
// active-provider label resolution for the response envelope.

import type { DaemonSessionHistory } from '../boot/daemon-runtime.js';
import { composeDaemonSystemPrompt } from '../boot/daemon-runtime.js';
import type { DaemonToolSurface } from '../boot/daemon-tools/types.js';
import { runDaemonPromptTurn } from '../boot/daemon-prompt-turn.js';
import {
  appendAssistantMessages,
  appendUserAndBuildMessages,
  appendUserPromptBlocksAndBuildMessages,
} from '../boot/daemon-history-helper.js';
import { appendWebtermContext } from '../boot/daemon-tools/webterm-context.js';
import { createToolCwdResolver } from '../boot/tool-cwd.js';
import { buildTerminalCapableTurn } from '../agent/terminal-surface.js';
import { PTY_SHELL_TOOL_NAMES } from '../boot/daemon-tools/pty-shell.js';
import { runGoalLoop } from '../core-turn/run-goal-loop.js';
import type { CoreTurnContext } from '../core-turn/types.js';
import { maybeImageBearingResult, type LLMMessage, type LLMToolSpec } from '../llm.js';
import { buildAcpPrompt, type NormalizedAttachment } from '../acp/content-blocks.js';
import {
  collectAgentContext,
  formatAgentPrompt,
  type AgentContext,
} from './agent-context-bundle.js';
import { inspectActiveProvider } from '../provider-summary.js';
import { getUserConfig } from '../user-config.js';
import { debug } from '../debug/log.js';

export interface AgentTurnInput {
  sessionId: string;
  terminalId: string;
  prompt: string;
  attachments?: NormalizedAttachment[];
  /** Phase 3 — `:agent --scroll N <prompt>` flag. When present, the
   *  context bundler caps the buffer dump to the last N lines. */
  scrollLines?: number;
  /** ACP streaming Phase A (PLAN-pwa-webterm-voice-control v1.2 · 2026-05-07) —
   *  forward streaming callbacks from runDaemonPromptTurn through to the
   *  `terminal/repl/exec` ACP handler so it can broadcast `session/update`
   *  notifications (`agent_message_chunk`, `tool_call`, etc) to every peer
   *  registered on this session. Default callers omit these and the turn
   *  loop runs unchanged (legacy single-response shape). */
  onTextDelta?: (delta: string, full: string) => void;
  onImageBlock?: (info: { src: string; mediaType: string; alt?: string }) => void;
  onToolCall?: (info: { id: string; name: string; args: Record<string, unknown> }) => void;
  onToolResultMeta?: (info: { id: string; name: string; ok: boolean; summary?: string }) => void;
  /** Select the existing across-turn goal engine. Omitted keeps the legacy single turn. */
  goalLoop?: boolean;
  /** Optional across-turn cap. Omitted lets the canonical engine use its configured default. */
  goalLoopMaxIterations?: number;
}

export interface AgentTurnDeps {
  history: DaemonSessionHistory;
  toolSurface?: DaemonToolSurface;
  toolCwd?: string;
  /** Base system prompt — daemon's `--system-prompt` value. The
   *  webterm-context block is layered in by `runDaemonPromptTurn`
   *  itself when the surface kind is `webterm`. */
  systemPrompt?: string;
  /** Test seam — substitute the runner used to drive the legacy LLM call. */
  runner?: typeof runDaemonPromptTurn;
  /** Test seam — substitute the existing across-turn engine. */
  goalLoopRunner?: typeof runGoalLoop;
  /** Test seam — substitute the context collector. Receives the
   *  optional `--scroll N` cap so tests can verify the bundler is
   *  invoked with the right opts. */
  collectContext?: (
    sessionId: string,
    terminalId: string,
    opts?: { maxLines?: number },
  ) => AgentContext;
}

export interface AgentTurnResult {
  sessionId: string;
  /** Final assistant text. PWA renders this as markdown in the
   *  AgentResponseSheet panel. */
  markdown: string;
  /** "<provider>/<model>" label so the panel header can show what
   *  produced the answer. */
  modelLabel: string;
  stopReason: string;
  /** Present only when the existing across-turn engine was selected. */
  goalLoop?: true;
  /** Echoed for telemetry — caller may want to show "with screenshot"
   *  hint when bufferLines > 0. */
  contextLines: number;
}

// Phase 4 (WT-A-3b) — abort registry. Each in-flight `:agent` turn
// registers its AbortController under `${sessionId}::${terminalId}` so
// the daemon's ACP `terminal/repl/agent/abort` method can fire it
// without threading the controller through the ACP server's options
// shape. The runner itself owns the lifecycle (register on enter,
// deregister in `finally`); `abortAgentTurn` is a one-shot lookup.
const activeTurns = new Map<string, AbortController>();

function turnKey(sessionId: string, terminalId: string): string {
  return `${sessionId}::${terminalId}`;
}

/** Phase 4 — fire the AbortController for the in-flight `:agent` turn
 *  scoped to this `(sessionId, terminalId)` pair. Returns `true` when
 *  a turn was matched + aborted, `false` when there was nothing to
 *  cancel. PWA TerminalRepl uses the boolean to decide whether to
 *  surface a "no active turn" toast (rare race; usually the spinner
 *  was already swapped to the response when Esc landed). */
export function abortAgentTurn(sessionId: string, terminalId: string): boolean {
  const ctrl = activeTurns.get(turnKey(sessionId, terminalId));
  if (!ctrl) return false;
  ctrl.abort();
  if (debug.enabled) {
    debug.log('webterm.agent', 'turn.abort', { sessionId, terminalId });
  }
  return true;
}

/** Test seam — peek at whether a turn is currently registered. Lets
 *  abort registry tests assert register + deregister without driving a
 *  full LLM round-trip. Production callers don't need this. */
export function _hasActiveAgentTurn(sessionId: string, terminalId: string): boolean {
  return activeTurns.has(turnKey(sessionId, terminalId));
}

async function runReplGoalLoop({
  deps,
  input,
  userText,
  promptBlocks,
  signal,
  goalLoopRunner,
}: {
  deps: AgentTurnDeps;
  input: AgentTurnInput;
  userText: string;
  promptBlocks: ReturnType<typeof buildAcpPrompt> | undefined;
  signal: AbortSignal;
  goalLoopRunner: typeof runGoalLoop;
}): Promise<{ sessionId: string; text: string; stopReason: string }> {
  const augmentedSystemPrompt = appendWebtermContext(
    composeDaemonSystemPrompt(deps.systemPrompt, undefined),
    input.terminalId,
    deps.toolSurface,
  );
  const tools: LLMToolSpec[] = deps.toolSurface && deps.toolSurface.kind !== 'none'
    ? deps.toolSurface.specs
    : [];
  const toolCwdResolver = createToolCwdResolver({
    tools: deps.toolSurface?.kind ?? 'none',
    ...(deps.toolCwd !== undefined ? { toolCwd: deps.toolCwd } : {}),
  });
  const rawDispatchTool: CoreTurnContext['dispatchTool'] = deps.toolSurface && deps.toolSurface.kind !== 'none'
    ? async (name, args) => deps.toolSurface!.dispatch(name, args, {
        cwd: toolCwdResolver.cwd!,
        resolveWriteCwd: toolCwdResolver.resolveWriteCwd,
        signal,
        sessionId: input.terminalId,
        entry: 'elanous-apparatus',
      })
    : async () => {
        throw new Error(':agent — daemon has no tool surface (start with `--tools webterm` for full vision-augmented agent)');
      };
  const terminal = tools.some((tool) => (PTY_SHELL_TOOL_NAMES as readonly string[]).includes(tool.name))
    ? buildTerminalCapableTurn({
        specs: tools,
        dispatch: rawDispatchTool,
        systemPromptParts: augmentedSystemPrompt ? [augmentedSystemPrompt] : [],
        signal,
        inlineImages: true,
      })
    : null;
  const effectiveSystemPrompt = terminal
    ? terminal.systemPromptParts.join('\n\n')
    : augmentedSystemPrompt;
  const messages = promptBlocks && promptBlocks.length > 0
    ? appendUserPromptBlocksAndBuildMessages(deps.history, input.sessionId, promptBlocks, effectiveSystemPrompt)
    : appendUserAndBuildMessages(deps.history, input.sessionId, userText, effectiveSystemPrompt);
  const result = await goalLoopRunner({
    sessionId: input.sessionId,
    userText,
    messages,
    tools,
    dispatchTool: terminal ? terminal.dispatch : rawDispatchTool,
    signal,
    ...(terminal?.llmOpts.budgetGrant ? { budgetGrant: terminal.llmOpts.budgetGrant } : {}),
    callbacks: {
      onTurnComplete: (newMessages: LLMMessage[]): void => {
        appendAssistantMessages(deps.history, input.sessionId, newMessages);
      },
      ...(input.onTextDelta ? { onText: input.onTextDelta } : {}),
      ...(input.onToolCall ? { onToolCall: input.onToolCall } : {}),
      ...(input.onImageBlock || input.onToolResultMeta
        ? {
            onToolResult: (call): void => {
              try {
                const imageBearing = maybeImageBearingResult(call.result);
                if (imageBearing && input.onImageBlock) {
                  input.onImageBlock({
                    src: `data:${imageBearing.mediaType};base64,${imageBearing.dataB64}`,
                    mediaType: imageBearing.mediaType,
                    alt: `${call.name} result`,
                  });
                }
                input.onToolResultMeta?.({ id: call.id, name: call.name, ok: true });
              } catch {
                // Supplemental output callbacks must not interrupt the selected engine.
              }
            },
          }
        : {}),
    },
  }, {
    ...(input.goalLoopMaxIterations !== undefined ? { maxIterations: input.goalLoopMaxIterations } : {}),
  });
  return { sessionId: input.sessionId, text: result.finalText, stopReason: result.stopReason };
}

/** Build a closure that runs `:agent <prompt>` against the daemon's
 *  shared history + tool surface. Caller provides the daemon-side
 *  plumbing once at boot; the returned function is then handed to the
 *  ACP server as `runAgentTurn`. */
export function createAgentTurnRunner(deps: AgentTurnDeps): (input: AgentTurnInput) => Promise<AgentTurnResult> {
  const runner = deps.runner ?? runDaemonPromptTurn;
  const goalLoopRunner = deps.goalLoopRunner ?? runGoalLoop;
  // Default collector wraps `collectAgentContext` (4-arg) in the
  // 3-arg test-friendly shape `(sid, tid, opts) => AgentContext`. The
  // resolver slot stays at its production default.
  const collect: NonNullable<AgentTurnDeps['collectContext']> = deps.collectContext
    ?? ((sid, tid, opts) => collectAgentContext(sid, tid, undefined, opts));
  return async (input) => {
    const ctx = collect(
      input.sessionId,
      input.terminalId,
      input.scrollLines && input.scrollLines > 0
        ? { maxLines: input.scrollLines }
        : undefined,
    );
    const userText = formatAgentPrompt(input.prompt, ctx);
    const promptBlocks = input.attachments && input.attachments.length > 0
      ? buildAcpPrompt(userText, input.attachments)
      : undefined;
    if (debug.enabled) {
      debug.log('webterm.agent', 'turn.begin', {
        sessionId: input.sessionId,
        terminalId: input.terminalId,
        promptLen: input.prompt.length,
        bufferLines: ctx.bufferLines,
        cwd: ctx.cwd,
        scrollLines: input.scrollLines ?? null,
        attachmentCount: input.attachments?.length ?? 0,
      });
    }
    // Phase 4 — per-turn AbortController registered under the
    // (sessionId, terminalId) pair. Defensive: if a previous turn
    // under the same key didn't deregister (handler crash mid-turn),
    // abort it so the new one wins. The previous runner's `finally`
    // still runs and its no-op-deregister is fine.
    const turnCtrl = new AbortController();
    const key = turnKey(input.sessionId, input.terminalId);
    const prev = activeTurns.get(key);
    if (prev) prev.abort();
    activeTurns.set(key, turnCtrl);
    const runOpts: Parameters<typeof runner>[0] = {
      history: deps.history,
      request: {
        sessionId: input.sessionId,
        userText,
        userContent: null,
        source: {
          kind: 'terminal',
          provider: 'tui',
          ...(input.terminalId ? { sessionId: input.terminalId } : {}),
        },
        effectiveSystemPrompt: composeDaemonSystemPrompt(deps.systemPrompt, undefined),
        tools: null,
      },
      ...(promptBlocks ? { promptBlocks } : {}),
      signal: turnCtrl.signal,
      dispatchToolErrorMessage: ':agent — daemon has no tool surface (start with `--tools webterm` for full vision-augmented agent)',
    };
    if (deps.toolSurface) runOpts.toolSurface = deps.toolSurface;
    if (deps.toolCwd) runOpts.toolCwd = deps.toolCwd;
    if (input.onTextDelta) runOpts.onTextDelta = input.onTextDelta;
    if (input.onImageBlock) runOpts.onImageBlock = input.onImageBlock;
    if (input.onToolResultMeta) runOpts.onToolResultMeta = input.onToolResultMeta;

    // ⛔⭐ 「에이전트가 도구를 «썼나 안 썼나»」를 로그로 답할 수 있게 한다 (대표 2026-08-17).
    //  📏 그 전 실물: `btop 을 실행해주세요` 턴(18:00:39)이 남긴 것은 turn.begin·turn.end 둘뿐이고
    //     ***툴 호출 관측이 한 줄도 없었다.*** 그래서 「실행했는데 화면이 안 바뀐 것」인지
    //     「애초에 아무것도 실행 안 한 것」인지 사람이 «가를 수 없었다».
    //  ⛔ 래퍼를 «항상» 붙인다 — `input.onToolCall` 은 선택 인자라, 호출자가 안 주면
    //     두 실행 경로(goal-loop · 단발) 어디에도 콜백이 없어 관측이 통째로 사라진다.
    //  ⭐ 그리고 「0회」가 «측정된 0» 이 되도록 turn.end 에 총계를 싣는다 — 부재를 값으로 말한다.
    let toolCallCount = 0;
    const observeToolCall = (info: { id: string; name: string; args: Record<string, unknown> }): void => {
      toolCallCount += 1;
      if (debug.enabled) {
        debug.log('webterm.agent', 'tool.call', {
          sessionId: input.sessionId,
          terminalId: input.terminalId,
          seq: toolCallCount,
          name: info.name,
          // ⛔ 값이 아니라 «키»만 — 인자에 토큰·경로 등이 실릴 수 있다. 무엇을 불렀나는 name 이 답한다.
          argKeys: Object.keys(info.args ?? {}).slice(0, 8),
        });
      }
      input.onToolCall?.(info);
    };
    runOpts.onToolCall = observeToolCall;
    const observedInput: AgentTurnInput = { ...input, onToolCall: observeToolCall };

    try {
      const result = input.goalLoop
        ? await runReplGoalLoop({
            deps,
            input: observedInput,
            userText,
            promptBlocks,
            signal: turnCtrl.signal,
            goalLoopRunner,
          })
        : await runner(runOpts);
      const provider = inspectActiveProvider(getUserConfig());
      const modelLabel = `${provider.provider}/${provider.model ?? '?'}`;
      if (debug.enabled) {
        debug.log('webterm.agent', 'turn.end', {
          sessionId: input.sessionId,
          terminalId: input.terminalId,
          stopReason: result.stopReason,
          textLen: result.text.length,
          modelLabel,
          // ⭐ 0 이면 「도구를 «한 번도» 안 썼다」가 «측정된 사실»이 된다 — 답만 하고 안 움직인 턴을 가른다.
          toolCalls: toolCallCount,
        });
      }
      return {
        sessionId: result.sessionId,
        markdown: result.text,
        modelLabel,
        stopReason: result.stopReason,
        ...(input.goalLoop === true ? { goalLoop: true } : {}),
        contextLines: ctx.bufferLines,
      };
    } finally {
      // Only delete when the registered controller is still ours —
      // a concurrent re-entry for the same (sessionId, terminalId)
      // would have overwritten the entry, and that newer controller
      // owns its own deregistration.
      if (activeTurns.get(key) === turnCtrl) {
        activeTurns.delete(key);
      }
    }
  };
}
