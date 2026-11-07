// Runs the plain dispatch's streaming round (`dashboardAcpSession.send`
// and its stream handlers), packaged as a callable so scheduled prompt
// sources can route text submissions through the same code path.
//
// What's STILL inline at the caller (full Step 2 extract is the next
// stone, ~1.5d remaining):
//   - Turn prelude — buildDashboardTurnPromptRuntime, compact preamble,
//     undo-turn arming, optional-tool-spec build
//   - Post-turn — parseDashboardActionBlock, finalizeDashboardStream
//     Lifecycle, history append
//
// This file's responsibility = ACP send + stream handler wiring.


/** ACP-style send call shape — wide enough to accept the existing
 *  `dashboardAcpSession.send` signature without depending on the ACP
 *  module directly (this helper sits below the dashboard so it can
 *  be unit-tested with a fake send). */
export interface DashboardPlainTurnAcpSend {
  // 반환은 await 후 discard — 구체 DashboardSession.send 가
  // Promise<DashboardSendResult> 를 돌려주므로 Promise<unknown> 로 수용.
  send(opts: {
    userText: string;
    signal: AbortSignal;
    onText: (chunk: string) => void;
    onToolCall: (call: unknown) => void;
    onToolResult: (call: unknown) => void;
    onUsage: (usage: unknown) => void;
    onThought?: (text: string) => void;
    onStatus?: (line: string) => void;
  }): Promise<unknown>;
}

export interface DashboardPlainTurnStreamDeps {
  userText: string;
  abortCtrl: AbortController;
  acpSession: DashboardPlainTurnAcpSend;

  /** Stream-runtime hooks (text/toolCall/toolResult/usage). The
   *  caller wires renderToolCallEvent / renderToolResultVariants /
   *  thinking line / etc. — this helper just passes the events
   *  through unchanged. */
  onText: (chunk: string, accumulated: string) => void;
  onToolCall: (call: unknown) => void;
  onToolResult: (call: unknown) => void;
  onUsage: (usage: unknown) => void;
  /** TUI-TURN-NARRATION — 추론 요약 문단(선택). */
  onThought?: (text: string) => void;
  /** Transient runtime status (for example, a stream retry notice). */
  onStatus?: (line: string) => void;

  /** ACP turn-ref reset hook — caller's `resetDashboardAcpTurnRef
   *  (acpTurnRef)`. Runs in the `finally` regardless of outcome. */
  resetTurnRef: () => void;
}

export interface DashboardPlainTurnStreamResult {
  fullResponse: string;
}

/**
 * Run a single plain-dispatch streaming turn. Routes ACP stream
 * deltas through the caller's stream-runtime hooks.
 *
 * Throws on dispatch error (so callers can route through their
 * existing error rendering).
 */
export async function runDashboardPlainTurnStream(
  deps: DashboardPlainTurnStreamDeps,
): Promise<DashboardPlainTurnStreamResult> {
  // 2026-05-03 PM++ — Per-tool-round accumulator. Reset on (1) the
  // empty-chunk clear signal (llm.ts:clearVisibleAssistantTextForToolRound
  // emits handlers.onText('', '') before tool dispatch — propagated as
  // chunk='' here), (2) onToolCall (new assistant run boundary).
  // Without these resets, the cross-turn cumulative `accumulated` was
  // forwarded to turn-stream-runtime via deps.onText(chunk, accumulated)
  // and the runtime's empty-chunk-replace branch (`perRoundText =
  // accumulated`) re-painted the chat with prior turns' narration —
  // exactly the user-reported codex narration accumulation bug. The
  // PR #1419 turn-stream-runtime fix targeted the symptom but missed
  // this upstream source of the cumulative accumulated parameter.
  let accumulated = '';
  // `cumulativeFullResponse` preserves the original cross-turn behavior
  // for callers that need the entire stream's text (recordTurnMetrics,
  // commitAssistantRenderState, runTailAutoCopy, runHandoffMirror,
  // parseActionBlock). Per-round reset only affects the `accumulated`
  // forwarded via onText to the runtime.
  let cumulativeFullResponse = '';

  try {
    await deps.acpSession.send({
      userText: deps.userText,
      signal: deps.abortCtrl.signal,
      onText: (chunk) => {
        if (chunk === '') {
          // Clear signal from llm.ts (clearVisibleAssistantTextForToolRound)
          // OR force-synthesis empty-chunk emit. Reset per-round
          // accumulated so the runtime's replace branch sees an empty
          // string (= true clear) instead of cumulative narration.
          accumulated = '';
        } else {
          accumulated += chunk;
          cumulativeFullResponse += chunk;
        }
        deps.onText(chunk, accumulated);
      },
      onToolCall: (call) => {
        // Tool round boundary — next assistant text run starts fresh.
        // Reset per-round accumulator so the runtime's append branch
        // doesn't carry prior turn's narration into the next round.
        accumulated = '';
        deps.onToolCall(call);
      },
      onToolResult: (call) => {
        accumulated = '';
        deps.onToolResult(call);
      },
      onUsage: (usage) => deps.onUsage(usage),
      ...(deps.onThought ? { onThought: (text: string) => deps.onThought!(text) } : {}),
      ...(deps.onStatus ? { onStatus: (line: string) => deps.onStatus!(line) } : {}),
    });
    // Return the cumulative full response so commit / metrics / autocopy
    // see the entire stream — only the per-round accumulator was
    // narrowed for runtime forwarding.
    return { fullResponse: cumulativeFullResponse };
  } finally {
    deps.resetTurnRef();
  }
}
