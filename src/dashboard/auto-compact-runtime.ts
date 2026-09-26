import type { LLMMessage } from '../llm.js';
import type { ChatMessage } from '../chat/index.js';
import type { CompactPipelineResult } from '../compact/types.js';
import type { CompactProvider } from '../compact/provider.js';
import type { ChatCompactConfig, ChatAutoCompactConfig } from '../user-config.js';

export interface DashboardAutoCompactDecision {
  fire: boolean;
  partial: boolean;
  preserveLastN: number;
  reason: string;
  ratio: number;
  usedTokens: number;
  maxTokens: number;
}

export interface DashboardAutoCompactRuntimeDeps {
  preamble: LLMMessage[];
  chatHistory: ChatMessage[];
  userMsg: ChatMessage;
  model: string;
  autoCompactConfig: ChatAutoCompactConfig;
  shouldAutoCompact: (
    messages: LLMMessage[],
    model: string,
    config: ChatAutoCompactConfig,
  ) => DashboardAutoCompactDecision;
  compactConversation: (
    history: LLMMessage[],
  ) => Promise<{ summary: string }>;
  compactConversationPartial: (
    history: LLMMessage[],
    opts: { upToIndex: number; preserveLastN: number },
  ) => Promise<{ summary: string }>;
  renderCompactBoundary: (mode: 'auto' | 'manual', detail?: string) => string;
  pushChatLine: (line: string) => void;
  pushDebugLine: (line: string) => void;
  muted: (text: string) => string;
  debugLog: (event: string, action: string, data?: unknown) => void;
  /** PR2 (HANDOFF 2026-05-04 §5.2) — compact pipeline integration.
   *  Optional so existing callers keep working until they wire it up;
   *  when present, Layer 1+2 (no-LLM tool-output budget + microcompact)
   *  runs before the threshold check, and verifyProbe + archive flags
   *  follow the user's ChatCompactConfig.
   *
   *  PR3 (§5.2 follow-up) — `getCompactProvider` enables the new
   *  Layer 3+5 fire path when shouldAutoCompact decides to compact.
   *  Without it, the runtime falls back to compactConversation /
   *  compactConversationPartial (legacy WF6 path). */
  chatCompactConfig?: ChatCompactConfig;
  runCompactPipeline?: (
    messages: LLMMessage[],
    opts: {
      sessionId: string;
      provider?: CompactProvider;
      activeModelId?: string;
    },
  ) => Promise<CompactPipelineResult>;
  getCompactProvider?: () => CompactProvider;
  setVerifyProbeEnabled?: (enabled: boolean) => void;
  sessionId?: string;
}

export async function runDashboardAutoCompact(
  deps: DashboardAutoCompactRuntimeDeps,
): Promise<void> {
  // PR2 §5.2 — Layer 1+2 pre-pass. Always free (no LLM call); trims
  // huge tool outputs + clears stale tool-results before the threshold
  // check sees them. shouldAutoCompact may decide *not* to fire after
  // the pre-pass, which is the desired outcome (free trim was enough).
  if (deps.runCompactPipeline) {
    if (deps.setVerifyProbeEnabled && deps.chatCompactConfig) {
      deps.setVerifyProbeEnabled(deps.chatCompactConfig.verifyProbe);
    }
    try {
      const sessionId = deps.sessionId ?? 'default';
      const messagesForPrePass = deps.chatHistory.slice(0, -1) as unknown as LLMMessage[];
      const prePass = await deps.runCompactPipeline(messagesForPrePass, { sessionId });
      const layer1Trimmed = prePass.diagnostics.layer1ResponsesTrimmed;
      const layer2Cleared = prePass.diagnostics.layer2MicrocompactCleared;
      if (layer1Trimmed > 0 || layer2Cleared > 0) {
        const systemMsg = deps.chatHistory.find((m) => m.role === 'system');
        const userMsg = deps.chatHistory[deps.chatHistory.length - 1];
        const newHistory = prePass.messages as unknown as ChatMessage[];
        deps.chatHistory.length = 0;
        if (systemMsg && !newHistory.some((m) => m.role === 'system')) {
          deps.chatHistory.push(systemMsg);
        }
        for (const m of newHistory) deps.chatHistory.push(m);
        if (userMsg) deps.chatHistory.push(userMsg);
        deps.debugLog(
          'chat.presentation.auto-compact.pre-pass',
          'applied',
          { layer1Trimmed, layer2Cleared, archived: prePass.diagnostics.archived },
        );
      }
    } catch (err) {
      deps.debugLog(
        'chat.presentation.auto-compact.pre-pass',
        'error',
        { message: err instanceof Error ? err.message : String(err) },
      );
    }
  }

  const autoDecision = deps.shouldAutoCompact(
    [
      ...deps.preamble,
      ...(deps.chatHistory.slice(0, -1) as unknown as LLMMessage[]),
      deps.userMsg as unknown as LLMMessage,
    ],
    deps.model,
    deps.autoCompactConfig,
  );
  deps.debugLog(
    'chat.presentation.auto-compact.decision',
    autoDecision.fire ? 'fire' : 'skip',
    autoDecision,
  );
  if (!autoDecision.fire) return;

  // PR3 §5.2 follow-up — pipeline-based fire path. When the caller
  // supplied both `runCompactPipeline` and `getCompactProvider`, run
  // Layer 1+2+3+5 in one shot (Layer 4 verify probe is opt-in via
  // chatCompactConfig.verifyProbe, applied above). Falls back to the
  // legacy compactConversation path on no-op or error so this is a
  // strictly-additive migration.
  if (deps.runCompactPipeline && deps.getCompactProvider) {
    let provider: CompactProvider | undefined;
    try {
      provider = deps.getCompactProvider();
    } catch {
      provider = undefined;
    }
    if (provider) {
      try {
        const messagesWithoutUser = deps.chatHistory.slice(0, -1) as unknown as LLMMessage[];
        const result = await deps.runCompactPipeline(messagesWithoutUser, {
          sessionId: deps.sessionId ?? 'default',
          provider,
          activeModelId: deps.model,
        });
        const layer3 = result.diagnostics.layer3SummaryApplied;
        const layer5 = result.diagnostics.layer5FallbackTruncated;
        if (layer3 || layer5) {
          const newHistory = result.messages as unknown as ChatMessage[];
          deps.chatHistory.length = 0;
          for (const m of newHistory) deps.chatHistory.push(m);
          deps.chatHistory.push(deps.userMsg);
          const tag = layer3
            ? `pipeline:${result.diagnostics.layer3SummaryModel || 'self'}`
            : 'fallback';
          deps.pushChatLine(deps.renderCompactBoundary(
            'auto',
            `${autoDecision.reason} ${(autoDecision.ratio * 100).toFixed(1)}% (${tag})`,
          ));
          deps.pushDebugLine(deps.muted(
            `[auto-compact pipeline: ${autoDecision.reason} ${autoDecision.usedTokens}/${autoDecision.maxTokens} (${(autoDecision.ratio * 100).toFixed(1)}%)${layer3 ? '' : ' fallback'}]`,
          ));
          deps.debugLog(
            'chat.presentation.auto-compact.pipeline',
            'applied',
            { layer3, layer5, model: result.diagnostics.layer3SummaryModel, verify: result.diagnostics.layer4VerifyVerdict },
          );
          return;
        }
        // Pipeline ran but produced no compaction (provider returned
        // null + fallback found no target). Fall through to legacy.
        deps.debugLog(
          'chat.presentation.auto-compact.pipeline',
          'no-op',
          { breaker: result.diagnostics.breakerTripped },
        );
      } catch (err) {
        deps.debugLog(
          'chat.presentation.auto-compact.pipeline',
          'error',
          { message: err instanceof Error ? err.message : String(err) },
        );
        // Fall through to legacy path below.
      }
    }
  }

  try {
    const currentHistory = deps.chatHistory.slice(0, -1) as unknown as LLMMessage[];
    let summary = '';
    if (autoDecision.partial) {
      let trailing = autoDecision.preserveLastN;
      let upToIndex = -1;
      for (let i = currentHistory.length - 1; i >= 0; i--) {
        if (currentHistory[i]!.role === 'system') continue;
        if (trailing > 0) {
          trailing--;
          continue;
        }
        upToIndex = i;
        break;
      }
      summary = (await deps.compactConversationPartial(currentHistory, {
        upToIndex,
        preserveLastN: autoDecision.preserveLastN,
      })).summary;
    } else {
      summary = (await deps.compactConversation(currentHistory)).summary;
    }
    if (!summary) return;

    const systemMsg = deps.chatHistory.find((message) => message.role === 'system');
    const tail = currentHistory.filter((message) => message.role !== 'system').slice(-autoDecision.preserveLastN);
    deps.chatHistory.length = 0;
    if (systemMsg) deps.chatHistory.push(systemMsg);
    deps.chatHistory.push({
      role: 'assistant',
      content: `Compacted conversation summary:\n\n${summary}`,
    } as ChatMessage);
    for (const entry of tail) deps.chatHistory.push(entry as unknown as ChatMessage);
    deps.pushChatLine(deps.renderCompactBoundary(
      'auto',
      `${autoDecision.reason} ${(autoDecision.ratio * 100).toFixed(1)}%${autoDecision.partial ? `, kept last ${autoDecision.preserveLastN}` : ''}`,
    ));
    deps.chatHistory.push(deps.userMsg);
    deps.pushDebugLine(deps.muted(
      `[auto-compact: ${autoDecision.reason} ${autoDecision.usedTokens}/${autoDecision.maxTokens} (${(autoDecision.ratio * 100).toFixed(1)}%)${autoDecision.partial ? `, kept last ${autoDecision.preserveLastN}` : ''}]`,
    ));
  } catch (err) {
    deps.pushDebugLine(deps.muted(`[auto-compact skipped: ${err instanceof Error ? err.message : String(err)}]`));
  }
}
