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

/** ★ COMPACT P0 (OP #123867, 2026-11-21) — user 원문 예산 이관이 발생하면 요약에
 *  찍히는 마커. 시험(test/compact-user-directives.test.ts)이 같은 문자열로 계약을
 *  고정한다(export — 매직 넘버 복제 금지). */
export const USER_BUDGET_TRANSFER_MARKER = '[user-directive-budget]';

/** Run Layer 1 (tool-output budget) + Layer 2 (microcompact) +
 *  optionally Layer 3 (LLM summarize when `opts.provider` is set).
 *  Returns a fresh message array — input is not mutated. */
export async function runCompactPipeline(
  messages: LLMMessage[],
  opts: RunCompactOpts = {},
): Promise<CompactPipelineResult & { preservedUserIndices?: number[] }> {
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
  let userDirectivesPreserved = 0;
  let userDirectivesBudgetTransferred: 0 | 1 = 0;
  let preservedUserIndices: number[] | undefined;
  const breakerTripped = isAutoCompactBreakerTripped() ? 1 : 0;

  const sliceUntil = Math.max(0, layer2.messages.length - policy.preserveLastN);
  // ★ 핵심 앵커 보존(2026-07-21) — 맨 앞 앵커(페이즈 프롬프트/WM/premise = 첫 user
  //   메시지)는 요약으로 뭉개지 않고 원문 유지(pin). preserveFirst=0 이면 기존 동작.
  const anchorCount = computeAnchorCount(layer2.messages, policy.preserveFirst, sliceUntil);
  const anchors = layer2.messages.slice(0, anchorCount);
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
        // ★ COMPACT P0 (OP #123867, 2026-11-21) — user 메시지는 구조적 보존 대상.
        //   압축은 assistant·tool 내용만 요약한다: 요약 슬라이스(앵커~tail 사이)의
        //   user 메시지는 원문 그대로(순서 유지) summary 바로 뒤에 재배치된다 —
        //   요약 모델이 지시를 빼먹어도 원문은 절대 소실되지 않는다(정규식·키워드
        //   분류 없이 role 기준 구조적 보존). policy.userPreserveBudgetChars 가
        //   지정되고 user 원문 합이 예산을 넘을 때만 **가장 오래된** user 메시지부터
        //   요약으로 이관되고 그 사실이 요약에 명시된다(USER_BUDGET_TRANSFER_MARKER).
        //   Wave 7 의 조건부 replay(마지막 user 1개만 재주입)는 이 보존으로 대체·폐지.
        const sliceMsgs = layer2.messages.slice(anchorCount, effectiveSliceUntil);
        const userTextLength = (m: LLMMessage): number =>
          typeof m.content === 'string'
            ? m.content.length
            : (m.content as ContentBlock[])
                .filter(b => (b as ContentBlock).type === 'text')
                .reduce((acc, b) => acc + (b as { text: string }).text.length, 0);

        const budget = policy.userPreserveBudgetChars;
        // newest→oldest 누적 — 예산 안에 드는 user 접미사(최신 쪽)만 원문 보존,
        // 그보다 오래된 user 전부 요약 이관. 예산 미지정(undefined)=전부 보존.
        let keepFrom = sliceMsgs.length;
        if (typeof budget === 'number' && Number.isFinite(budget) && budget >= 0) {
          let acc = 0;
          for (let i = sliceMsgs.length - 1; i >= 0; i--) {
            const m = sliceMsgs[i]!;
            if (!isHumanUserMessage(m)) continue;
            const len = userTextLength(m);
            if (acc + len > budget) break;
            acc += len;
            keepFrom = i;
          }
        } else {
          keepFrom = 0;
        }
        const transferred = sliceMsgs.filter((m, i) => isHumanUserMessage(m) && i < keepFrom).length;
        const keptPositions: number[] = [];
        sliceMsgs.forEach((m, i) => {
          if (isHumanUserMessage(m) && i >= keepFrom) keptPositions.push(anchorCount + i);
        });
        const preservedUsers = keptPositions.map(p => layer2.messages[p]!);
        const summaryContent =
          transferred > 0
            ? `<context_summary>\n${summary.summary}\n${USER_BUDGET_TRANSFER_MARKER} 가장 오래된 user 메시지 ${transferred}건이 원문 예산(${budget}자) 초과로 이 요약으로 이관됐다.\n</context_summary>`
            : `<context_summary>\n${summary.summary}\n</context_summary>`;
        const summaryMsg: LLMMessage = {
          role: 'system',
          content: summaryContent,
          cacheVolatile: true,
        };
        messagesAfter = [
          ...anchors,
          summaryMsg,
          ...preservedUsers,
          ...tail,
        ];
        userDirectivesPreserved = preservedUsers.length;
        userDirectivesBudgetTransferred = transferred > 0 ? 1 : 0;
        preservedUserIndices = keptPositions;
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
    ...(preservedUserIndices ? { preservedUserIndices } : {}),
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
      userDirectivesPreserved,
      userDirectivesBudgetTransferred,
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

/** ★ COMPACT P0(OP #123867) — «사람 user 행» 구조적 판별(보존·drop 공용 계약).
 *  tool_result 블록을 싣은 user 메시지는 사람 말이 아니라 «도구 출력»이다(OP 처방 ①
 *  «assistant·tool 내용만 요약») — role 이 user 라도 tool_result 캐리어면 보존 대상에서
 *  제외되어 짝(tool_use)과 함께 요약 슬라이스에 남는다. 원문으로 살리면 짝만 요약돼
 *  유령 tool_result 가 되어 wire 가 깨진다. 혼합(tool_result+text) 행도 캐리어다.
 *  구조적 기준(content 블록 type)이지 키워드·정규식 분류가 아니다. compact-session 의
 *  overflow 재시도 drop 후보 선정도 이 계약을 공유한다(JUD-B #124147 · OP #124161). */
export function isHumanUserMessage(m: LLMMessage): boolean {
  // CEO-UTTERANCE-TAGGED-LAST ④ — human means the stored row's `from.kind === 'human'` when the provenance is known.
  if (m.speaker !== undefined && m.speaker !== 'human') return false;
  return m.role === 'user'
    && (typeof m.content === 'string'
      || !(m.content as ContentBlock[]).some(b => (b as ContentBlock).type === 'tool_result'));
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
