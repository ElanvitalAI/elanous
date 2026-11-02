// ── Wave 2 · compact pipeline (Layer 1+2) ──────────────────────────
//
// Sequence the no-LLM layers and aggregate diagnostics into a
// single `CompactPipelineResult`. Layer 3 (LLM summarize · Wave 4) and
// Layer 4 (verify probe · Wave 5) plug in over this same orchestrator
// once their provider contract lands.

import type { ContentBlock, LLMMessage } from '../llm.js';
import { applyMicrocompact } from './microcompact.js';
import { applyToolOutputBudget } from './tool-output-budget.js';
import type { CompactProvider } from './provider.js';
import {
  isAutoCompactBreakerTripped,
  isVerifyProbeEnabled,
  recordAutoCompactFailure,
  recordAutoCompactSuccess,
} from './auto-state.js';
import { runVerifyProbe } from './verify-probe.js';
import { truncateProportional } from './truncate-proportional.js';
import {
  DEFAULT_COMPACT_POLICY,
  type CompactPolicy,
  type CompactPipelineResult,
} from './types.js';

export interface RunCompactOpts {
  policy?: Partial<CompactPolicy>;
  sessionId?: string;
  now?: () => number;
  /** Wave 4 · when set, after Layers 1+2 the pipeline runs Layer 3
   *  (LLM summarize via the provider) replacing the
   *  pre-preserveLastN slice with a single summary message. */
  provider?: CompactProvider;
  /** Active model — fed to provider for summarizerModelHint
   *  resolution. Only meaningful when `provider` is set. */
  activeModelId?: string;
  /** User `/compact <hint>` — forwarded to provider. */
  summaryHint?: string;
}

/** Run Layer 1 (tool-output budget) + Layer 2 (microcompact) +
 *  optionally Layer 3 (LLM summarize when `opts.provider` is set).
 *  Returns a fresh message array — input is not mutated. */
export async function runCompactPipeline(
  messages: LLMMessage[],
  opts: RunCompactOpts = {},
): Promise<CompactPipelineResult> {
  const policy = { ...DEFAULT_COMPACT_POLICY, ...opts.policy };
  const sessionId = opts.sessionId ?? 'default';
  const now = opts.now ?? Date.now;

  const layer1 = applyToolOutputBudget(messages, { policy, sessionId, now });
  const layer2 = applyMicrocompact(layer1.messages, { policy, sessionId, now });

  // Wave 4 · Layer 3 — LLM summarize. Wave 5 wraps it with a
  // breaker check (skip when tripped), verify probe (opt-in), and
  // truncateProportional fallback when summarize returns null /
  // verify rejects.
  let messagesAfter: LLMMessage[] = layer2.messages;
  let layer3Applied: 0 | 1 = 0;
  let layer3Model = '';
  let layer3Chars = 0;
  let layer4Verdict: 'skipped' | 'ok' | 'rejected' = 'skipped';
  let layer5FallbackTruncated: 0 | 1 = 0;
  let userReplayApplied: 0 | 1 = 0;
  const breakerTripped = isAutoCompactBreakerTripped() ? 1 : 0;

  const sliceUntil = Math.max(0, layer2.messages.length - policy.preserveLastN);
  // ★ 핵심 앵커 보존(2026-07-21) — 맨 앞 앵커(페이즈 프롬프트/WM/premise = 첫 user
  //   메시지)는 요약으로 뭉개지 않고 원문 유지(pin). preserveFirst=0 이면 기존 동작.
  const anchorCount = computeAnchorCount(layer2.messages, policy.preserveFirst, sliceUntil);
  const anchors = layer2.messages.slice(0, anchorCount);
  const anchorHasUser = anchors.some(m => m.role === 'user');
  const sliceForSummary = layer2.messages.slice(anchorCount, sliceUntil);

  // 앵커+tail 이 전부를 덮어 요약할 중간이 없으면 L3 스킵(무의미한 요약·null 방지).
  if (opts.provider && !breakerTripped && sliceForSummary.length > 0) {
    const summary = await opts.provider.summarize({
      messages: layer2.messages,
      preserveLastN: policy.preserveLastN,
      preserveFirst: anchorCount,
      hint: opts.summaryHint,
      ...(opts.activeModelId ? { activeModelId: opts.activeModelId } : {}),
    });
    if (summary) {
      // Wave 5 · optional verify probe — only when explicitly opted in.
      let acceptSummary = true;
      if (isVerifyProbeEnabled() && sliceForSummary.length > 0) {
        const probe = await runVerifyProbe({
          summary: summary.summary,
          originalSlice: sliceForSummary,
          ...(opts.activeModelId ? { activeModelId: opts.activeModelId } : {}),
        });
        layer4Verdict = probe.ok ? 'ok' : 'rejected';
        acceptSummary = probe.ok;
      } else {
        layer4Verdict = 'skipped';
      }
      if (acceptSummary) {
        const effectiveSliceUntil = summary.preservedTailFrom ?? sliceUntil;
        const tail = layer2.messages.slice(effectiveSliceUntil);
        const summaryMsg: LLMMessage = {
          role: 'system',
          content: `<context_summary>\n${summary.summary}\n</context_summary>`,
          cacheVolatile: true,
        };
        // Wave 7 (2026-05-04) — user-message replay. ref/opencode
        // `compaction.process` (session/compaction.ts:155-175,
        // 283-338) pattern: when the summarized slice contained the
        // user's task-intent message and the tail is assistant-only
        // (multi-turn assistant chain → no user in preserveLastN),
        // the model loses its anchor to "what was I asked to do?".
        // Re-emit the last user message from the slice (text-only,
        // media stripped to keep the replay clean) right after the
        // summary so task continuation is explicit.
        // ★ 앵커가 이미 user(=task-intent) 를 pin 했으면 replay 불필요(중복 앵커 방지).
        //   앵커 미보존(preserveFirst=0) 시엔 기존 replay 로직 유지.
        const tailHasUser = tail.some(m => m.role === 'user');
        let replayedUser: LLMMessage | null = null;
        if (!tailHasUser && !anchorHasUser) {
          for (let i = sliceForSummary.length - 1; i >= 0; i--) {
            const m = sliceForSummary[i]!;
            if (m.role !== 'user') continue;
            const text = typeof m.content === 'string'
              ? m.content
              : (m.content as ContentBlock[])
                  .filter(b => (b as ContentBlock).type === 'text')
                  .map(b => (b as { text: string }).text)
                  .join('\n');
            if (text.trim().length > 0) {
              replayedUser = { role: 'user', content: text };
            }
            break;
          }
        }
        messagesAfter = [
          ...anchors,
          summaryMsg,
          ...(replayedUser ? [replayedUser] : []),
          ...tail,
        ];
        userReplayApplied = replayedUser ? 1 : 0;
        layer3Applied = 1;
        layer3Model = summary.modelUsed ?? '';
        layer3Chars = summary.summary.length;
        recordAutoCompactSuccess();
      } else {
        // Verify rejected → Layer 5 fallback.
        const fallback = applyTruncateFallback(layer2.messages, policy, anchorCount);
        messagesAfter = fallback.messages;
        layer5FallbackTruncated = fallback.truncated;
        recordAutoCompactFailure('verify-rejected');
      }
    } else {
      // summarize() returned null → Wave 5 fallback + breaker bump.
      const fallback = applyTruncateFallback(layer2.messages, policy, anchorCount);
      messagesAfter = fallback.messages;
      layer5FallbackTruncated = fallback.truncated;
      recordAutoCompactFailure('summarize-null');
    }
  }

  return {
    messages: messagesAfter,
    diagnostics: {
      layer1ToolOutputBudgetSavedChars: layer1.savedChars,
      layer1ResponsesTrimmed: layer1.responsesTrimmed,
      layer2MicrocompactCleared: layer2.cleared,
      layer2MicrocompactSavedChars: layer2.savedChars,
      layer3SummaryApplied: layer3Applied,
      layer3SummaryModel: layer3Model,
      layer3SummaryChars: layer3Chars,
      layer4VerifyVerdict: layer4Verdict,
      layer5FallbackTruncated,
      breakerTripped: breakerTripped as 0 | 1,
      archived: (policy.archiveEnabled
        ? layer1.responsesTrimmed + layer2.cleared
        : 0),
      userReplayApplied,
    },
  };
}

/** ★ 핵심 앵커 개수 산정(2026-07-21) — 맨 앞 preserveFirst 개를 pin 하되, 리딩
 *  system 메시지가 앞서더라도 **첫 user 메시지(페이즈 프롬프트/task-intent)** 까지
 *  자동 확장한다. sliceUntil(요약 경계)을 넘지 않도록 캡. preserveFirst<=0 이면 0. */
export function computeAnchorCount(
  messages: readonly LLMMessage[],
  preserveFirst: number,
  sliceUntil: number,
): number {
  if (preserveFirst <= 0 || sliceUntil <= 0) return 0;
  let count = Math.min(preserveFirst, sliceUntil);
  const firstUserIdx = messages.findIndex(m => m.role === 'user');
  if (firstUserIdx >= 0 && firstUserIdx < sliceUntil) {
    count = Math.max(count, firstUserIdx + 1);
  }
  return Math.min(count, sliceUntil);
}

/** Wave 5 fallback — truncateProportional applied to the largest
 *  tool_result block in the message array. Guarantees *some*
 *  reduction when the provider summarize fails. `anchorCount` pins the
 *  leading anchors (phase prompt/WM) — never truncated. */
function applyTruncateFallback(
  messages: LLMMessage[],
  policy: CompactPolicy,
  anchorCount = 0,
): { messages: LLMMessage[]; truncated: 0 | 1 } {
  // Find the largest tool_result outside the preserve window (anchors + tail).
  const preserveFromIdx = Math.max(0, messages.length - policy.preserveLastN);
  const scanFrom = Math.max(0, Math.min(anchorCount, preserveFromIdx));
  let bestIdx = -1;
  let bestBlockIdx = -1;
  let bestSize = 0;
  for (let i = scanFrom; i < preserveFromIdx; i++) {
    const m = messages[i]!;
    if (typeof m.content === 'string') continue;
    const blocks = m.content as ContentBlock[];
    for (let b = 0; b < blocks.length; b++) {
      const blk = blocks[b]!;
      if (blk.type === 'tool_result' && typeof blk.content === 'string' && blk.content.length > bestSize) {
        bestSize = blk.content.length;
        bestIdx = i;
        bestBlockIdx = b;
      }
    }
  }
  if (bestIdx < 0) return { messages, truncated: 0 };
  const out = messages.slice();
  const target = out[bestIdx]!;
  const blocks = (target.content as ContentBlock[]).slice();
  const original = blocks[bestBlockIdx]! as Extract<ContentBlock, { type: 'tool_result' }>;
  // Narrowed by the bestIdx selection above (only string-content blocks
  // are eligible). Array content (image tool_result) is opaque to the
  // proportional truncator and would already be small (image bytes are
  // shipped via base64; metadata text is short).
  const originalText = typeof original.content === 'string' ? original.content : '';
  const truncated = truncateProportional({
    text: originalText,
    maxChars: Math.max(1000, Math.floor(policy.toolOutputCharBudget / 2)),
  });
  blocks[bestBlockIdx] = { ...original, content: truncated };
  out[bestIdx] = { ...target, content: blocks };
  return { messages: out, truncated: 1 };
}
