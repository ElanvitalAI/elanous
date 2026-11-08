import type { LLMToolSpec } from '../llm/tool-spec.js';
// src/autopilot/elanous-builtin-runner.ts
//
// ROADMAP-elanous-builtin-autopilot-cascade §MB-3.
//
// `LlmTurnRunner` 의 두 번째 구현 — ACP CLI sub-process 가 아니라
// NEXUS in-process LLM rotation 위 동작. `runCoreTurn` 을 wrap 해서
// elanous 의 native tool registry · permission · rotation · in-process
// latency 를 autopilot 의 default substrate 로 격상.
//
// 동작:
//   1. `prompt(blocks, onUpdate)` 호출 시 ACP ContentBlock[] 을 LLM
//      content 로 convert 후 user message 추가
//   2. `runCoreTurn` 호출 — getAutopilotToolRegistry (MB-2) 의 tools
//      + dispatchTool 사용
//   3. runCoreTurn 의 callback (onText / onToolCall / onToolResult /
//      onTurnComplete) 을 ACP SessionUpdate shape 로 adapter → onUpdate
//      callback 으로 emit. driver 의 risky-pattern · terminal-forwarder
//      · screenshot reflection seam 이 ACP backend 와 동일 동작.
//   4. `onTurnComplete` 에서 assistant + tool messages 를 internal
//      history 에 push — 다음 iteration 의 prompt() 시 conversation 유지
//   5. `cancel()` → abort signal → runCoreTurn 이 `stopReason: 'aborted'`
//      반환 → 본 wrapper 가 ACP `'cancelled'` 로 map
//
// 첫 cut 의 system prompt 는 caller 가 명시 (autopilot driver 가
// mission text 를 첫 user block 으로 보내므로 system context 는 thin).
// MB-6 polish 시 mission-type-aware system prompt 추가 후보.

import { runCoreTurn } from '../core-turn/run-core-turn.js';
import type { CoreTurnDispatchTool, CoreTurnStopReason } from '../core-turn/types.js';
import {
  acpPromptToLlmContent,
  flattenLlmContent,
} from '../acp/content-blocks.js';
import { debug } from '../debug/log.js';
import { streamLLM, type LLMMessage } from '../llm.js';
import { getUserConfig } from '../user-config.js';
import { resolveAutoRoute, lookupLlmTierSpec, logRouterDecision } from '../model-tier/index.js';
import type { LlmRunner } from '../model-tier/preset-suggest-llm.js';
import type {
  AcpPromptResult,
  AcpUpdateCallback,
} from '../acp/client.js';
import type {
  ContentBlock,
  SessionUpdate,
  StopReason,
} from '@agentclientprotocol/sdk';
import type { LlmTurnRunner } from './runner.js';

/**
 * Map a core-turn stop reason onto the ACP wire `StopReason` set.
 * `auth_rejected` is not an ACP wire value (re-auth vs bug); this
 * consumer treats it as a failure (`refusal`), never a successful turn.
 * Exhaustive: a new `CoreTurnStopReason` member is a compile error here
 * instead of falling through to `end_turn`.
 */
export function mapCoreTurnStopReason(reason: CoreTurnStopReason): StopReason {
  switch (reason) {
    case 'end_turn':
      return 'end_turn';
    case 'max_turns':
      return 'max_turn_requests';
    case 'aborted':
      return 'cancelled';
    case 'error':
      return 'refusal';
    case 'auth_rejected':
      return 'refusal';
    default: {
      const _exhaustive: never = reason;
      void _exhaustive;
      return 'refusal';
    }
  }
}

/** Return only the current prompt's human text for surface selection.
 * Non-text ACP blocks remain available to the LLM in `userContent` but
 * must not become routing intent. */
function selectUserText(userContent: LLMMessage['content']): string | undefined {
  if (typeof userContent === 'string') return userContent;
  const text = userContent
    .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('');
  return text.length > 0 ? text : undefined;
}

export interface ElanousBuiltinTurnRunnerOptions {
  /** ACP-style session id. Forwarded to `runCoreTurn` so session-keyed
   *  dispatchers (preview-tap-registry · kgs scope · WebTerminal*)
   *  resolve the right scope. */
  sessionId: string;
  /** LLM tool catalog. Usually built by
   *  {@link import('./tool-registry.js').getAutopilotToolRegistry}. */
  tools: LLMToolSpec[];
  /** Dispatcher invoked when the model picks a tool. Usually built by
   *  the same helper as `tools`. */
  dispatchTool: CoreTurnDispatchTool;
  /** Optional system message prepended to history. autopilot driver
   *  carries mission/plan as the first user block so default = none. */
  systemPrompt?: string;
  /** Optional per-turn LLM override (anthropic/claude-sonnet-...). */
  modelOverride?: string;
  /** Optional max tool-loop turns per `prompt()` invocation. */
  maxToolTurns?: number;
}

/**
 * MB-3 — in-process LLM rotation runner. `AutopilotLoopDriver` instantiates
 * one per mission; the same instance is reused across iterations so the
 * conversation accumulates assistant + tool messages naturally.
 */
export class ElanousBuiltinTurnRunner implements LlmTurnRunner {
  private readonly options: ElanousBuiltinTurnRunnerOptions;
  private readonly messages: LLMMessage[] = [];
  private abortController: AbortController | null = null;

  constructor(opts: ElanousBuiltinTurnRunnerOptions) {
    this.options = opts;
    if (opts.systemPrompt && opts.systemPrompt.length > 0) {
      this.messages.push({ role: 'system', content: opts.systemPrompt });
    }
  }

  async prompt(
    blocks: ContentBlock[],
    onUpdate: AcpUpdateCallback,
  ): Promise<AcpPromptResult> {
    // 1) ACP blocks → LLM content. flattenLlmContent collapses
    //    all-text bundles back to plain string for legacy parity.
    const llmContent = acpPromptToLlmContent(blocks);
    const userContent = flattenLlmContent(llmContent);
    const userText = selectUserText(userContent);
    this.messages.push({
      role: 'user',
      content: userContent,
    });

    // 2) Fresh AbortController per turn — cancel() targets THIS turn,
    //    not a leftover signal from a prior iteration.
    const ctrl = new AbortController();
    this.abortController = ctrl;

    if (debug.enabled) {
      debug.log('autopilot.elanous-builtin', 'prompt.begin', {
        sessionId: this.options.sessionId,
        historyLen: this.messages.length,
        toolCount: this.options.tools.length,
      });
    }

    // 3) Dispatch through runCoreTurn — its callbacks become ACP
    //    SessionUpdate emissions so the driver's risky-pattern +
    //    terminal-forwarder seams work without backend-specific
    //    branches.
    // PLAN-model-intelligence-router · Part B — per-turn smart routing.
    // Only when NO model is explicitly pinned (an autonomous mission turn
    // is exactly the `auto`/unpinned case the router targets). An explicit
    // `modelOverride` always wins — the router never overrides a pin.
    const effectiveModelOverride = this.options.modelOverride
      ?? (userText !== undefined
        ? await this.resolveAutoRouteModel(userText)
        : undefined);

    let result;
    try {
      result = await runCoreTurn({
        sessionId: this.options.sessionId,
        ...(userText !== undefined ? { userText } : {}),
        messages: this.messages,
        tools: this.options.tools,
        dispatchTool: this.options.dispatchTool,
        signal: ctrl.signal,
        ...(effectiveModelOverride !== undefined
          ? { modelOverride: effectiveModelOverride }
          : {}),
        ...(this.options.maxToolTurns !== undefined
          ? { maxToolTurns: this.options.maxToolTurns }
          : {}),
        callbacks: {
          onText: (delta) => {
            if (delta.length === 0) return;
            onUpdate({
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: delta },
            } as unknown as SessionUpdate);
          },
          onToolCall: (call) => {
            onUpdate({
              sessionUpdate: 'tool_call',
              toolCallId: call.id,
              toolName: call.name,
              title: call.name,
              status: 'in_progress',
              rawInput: call.args,
            } as unknown as SessionUpdate);
          },
          onToolResult: (call) => {
            onUpdate({
              sessionUpdate: 'tool_call_update',
              toolCallId: call.id,
              status: 'completed',
              rawOutput: call.result,
            } as unknown as SessionUpdate);
          },
          onTurnComplete: (newMessages) => {
            // Persist assistant + tool-result blocks back into history
            // so the next iteration sees real tool evidence.
            this.messages.push(...newMessages);
          },
        },
      });
    } finally {
      // Only clear if this turn's controller is still active; a parallel
      // cancel() may have already nulled it out (defensive, not strictly
      // possible today since prompt() is serialized per session).
      if (this.abortController === ctrl) this.abortController = null;
    }

    const stopReason: StopReason = mapCoreTurnStopReason(result.stopReason);

    if (debug.enabled) {
      debug.log('autopilot.elanous-builtin', 'prompt.end', {
        sessionId: this.options.sessionId,
        stopReason,
        coreStopReason: result.stopReason,
        finalChars: result.finalText.length,
      });
    }

    return { stopReason };
  }

  async cancel(): Promise<void> {
    this.abortController?.abort();
  }

  /** PLAN-model-intelligence-router · Part B — resolve a per-turn model
   *  from the input's difficulty when `llm.autoRoute.enabled`. Returns
   *  `undefined` (→ core-turn default) when routing is off or on any
   *  failure. Never throws into the turn. */
  private async resolveAutoRouteModel(userText: string): Promise<string | undefined> {
    try {
      const cfg = getUserConfig();
      const ar = cfg.llm.autoRoute;
      if (!ar?.enabled) return undefined;
      const provider = cfg.llm.provider;

      // Hybrid escalation: when enabled, the classifier runs on the
      // provider's BUDGET-tier model so the routing decision itself is
      // cheap (a small model deciding whether the real turn needs a big
      // one). Heuristic-only otherwise — zero extra LLM cost.
      let runLlm: LlmRunner | undefined;
      if (ar.useClassifierLlm) {
        const cheap = lookupLlmTierSpec(provider, 'budget').model;
        runLlm = async (msgs) => {
          let full = '';
          await streamLLM(
            msgs.map((m) => ({ role: m.role, content: m.content })) as LLMMessage[],
            (_delta, all) => { full = all; },
            { model: cheap },
          );
          return full;
        };
      }

      const route = await resolveAutoRoute(
        { text: userText, kind: 'task', toolCount: this.options.tools.length },
        { provider, runLlm },
        { enabled: true, applyNuance: ar.applyNuance === true },
      );
      if (!route) return undefined;
      logRouterDecision({
        tier: route.tier,
        model: route.model,
        source: route.source,
        rationale: route.rationale,
        provider,
        text: userText,
        sessionId: this.options.sessionId,
      });
      if (debug.enabled) {
        debug.log('autopilot.elanous-builtin', 'autoroute.decision', {
          sessionId: this.options.sessionId,
          tier: route.tier,
          model: route.model,
          source: route.source,
          rationale: route.rationale,
        });
      }
      return route.model;
    } catch (err) {
      debug.log('autopilot.elanous-builtin', 'autoroute.error', {
        error: err instanceof Error ? err.message : String(err),
      }, { level: 'error' });
      return undefined;
    }
  }

  /** Visible to tests — returns a shallow snapshot of the internal
   *  history so callers can assert turn accumulation without poking
   *  the private field. */
  _getHistoryForTesting(): readonly LLMMessage[] {
    return [...this.messages];
  }
}
