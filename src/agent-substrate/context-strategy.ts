// agent-loop-substrate 조각2 — pluggable context 전략 (read-time projection / 2-tier compaction) 2026-07-19
//
// ★ RESEARCH-orchestrator-free-system-core #2. 조율자 유무 무관 "루프-분리 교체형 context 전략" substrate
//   프리미티브. 세 레포 동형: AutoGen ChatCompletionContext(get_messages=read-time projection)·LangGraph
//   pre_model_hook(원본 보존·LLM view 만 가공)·Claude Code 2-tier(microcompact→autocompact). elanous 는
//   `runCompactPipeline`(L1 tool-output=micro·L3 요약=auto)로 2-tier 를 이미 보유하나 streamLLMWithTools 에
//   **인라인 산재** — 이 모듈이 그걸 **교체형 전략 인터페이스**로 추출해 loop/orchestrator 가 주입·공유하게.
//
// ★ orchestrator 상속 정합(대표 원칙 2026-07-19) — 전략은 "LLM 에 보낼 view"만 만들 뿐 원본 history 는 caller
//   소유. orchestrator 의 전체문맥 인지는 substrate 저장소 read-through(별개)라 이 전략과 직교. 기본 전략은
//   현 인라인 로직을 무회귀 이관(behavior-preserving) — 주입 전략(read-time projection 등)으로 확장 가능.

import type { LLMMessage } from '../llm.js';
import { estimateMessagesTokens } from '../tokens.js';

/** 압축 판정+수행 결과 — caller(loop)가 splice/관측/breaker 분기. */
export interface CompactionOutcome {
  /** shouldAutoCompact 가 fire 했나(임계 초과). false 면 압축 미시도(messages=원본). */
  fired: boolean;
  /** 압축 후보 메시지(fire 시 2-tier 결과·아니면 원본). */
  messages: LLMMessage[];
  /** ★ 실제 **크기(추정 토큰)** 축소 여부(2026-07-21). ⚠️ 이전엔 messages.length(개수)
   *  로 판정 → L1/L2/L5 는 **내용**만 줄이고 개수는 유지 → reduced=false 오판 →
   *  breaker no-reduce 실패 누적(라이브 705308 폭발). 이제 afterTokens<beforeTokens 로
   *  실제 감소를 본다(compaction-no-reduce 오판 근절). caller 는 reduced 일 때만 splice. */
  reduced: boolean;
  /** L3(LLM 요약)로 에스컬레이션됐나(관측). */
  escalated: boolean;
  /** 판정 지표(관측·자기인지). */
  ratio: number;
  usedTokens: number;
  /** ★ 관측(2026-07-21) — 압축 전/후 추정 토큰. reduced 판정 근거·다음 폭발 시
   *  compact-breaker 진단(debug.log 로 방출). */
  beforeTokens: number;
  afterTokens: number;
}

/** ChatAutoCompactConfig 에 preserveFirstN(핵심 앵커 pin 개수) 이 실릴 수 있어
 *  선택 필드로 읽는다. 미설정(구 config·테스트)이면 기본 1(첫 앵커 pin). 0=비활성. */
interface AutoCompactCfgWithAnchor { preserveFirstN?: number }

/** context 전략 계약 — loop 이 mid-loop(turn>0) 호출. 기본=2-tier compaction. 주입으로 교체(read-time projection 등). */
export interface ContextStrategy {
  compact(messages: LLMMessage[], ctx: { model: string; sessionId?: string; config: unknown; observedInputTokens?: number }): Promise<CompactionOutcome>;
}

/**
 * ★ 조각2 기본 전략 — 현 streamLLMWithTools midloop 인라인 로직을 무회귀 이관(behavior-preserving).
 * cheap 패스(L1/L2) → 여전히 임계 초과면 L3(LLM 요약) 에스컬레이션 → 축소분만 반환. runCompactPipeline
 * (검증된 5레이어)를 그대로 소비. fired=false 면 원본 그대로(무비용). fail-soft(예외는 caller catch).
 */
export function createDefaultContextStrategy(): ContextStrategy {
  return {
    async compact(messages, ctx): Promise<CompactionOutcome> {
      const { shouldAutoCompact } = require('../compact/auto.js') as typeof import('../compact/auto.js');
      const acCfg = ctx.config as Parameters<typeof shouldAutoCompact>[2];
      const decision = shouldAutoCompact(messages, ctx.model, acCfg, ctx.observedInputTokens);
      const beforeTokens = estimateMessagesTokens(messages);
      if (!decision.fire) {
        return { fired: false, messages, reduced: false, escalated: false, ratio: decision.ratio, usedTokens: decision.usedTokens, beforeTokens, afterTokens: beforeTokens };
      }
      const { runCompactPipeline } = require('../compact/pipeline.js') as typeof import('../compact/pipeline.js');
      // ★ 핵심 앵커 pin — config.preserveFirstN(기본 1). 0 이면 앵커 보존 비활성(롤백 seam).
      const preserveFirst = Math.max(0, (acCfg as AutoCompactCfgWithAnchor).preserveFirstN ?? 1);
      const compactOpts = { activeModelId: ctx.model, policy: { preserveFirst }, ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}) };
      let compacted = await runCompactPipeline(messages, compactOpts);
      let escalated = false;
      // cheap 패스로 부족하면 L3(LLM 요약) 에스컬레이션(정상 tool-bloat 턴은 여기 안 옴 → LLM 비용 0).
      if (shouldAutoCompact(compacted.messages, ctx.model, acCfg).fire) {
        const { getDefaultCompactProvider } = require('../compact/provider.js') as typeof import('../compact/provider.js');
        const deep = await runCompactPipeline(messages, { ...compactOpts, provider: getDefaultCompactProvider() });
        // ★ 에스컬레이션 채택도 **토큰** 기준(개수 아님) — L3 요약이 개수는 늘려도 토큰은 더 줄 수 있다.
        if (estimateMessagesTokens(deep.messages) < estimateMessagesTokens(compacted.messages)) { compacted = deep; escalated = true; }
      }
      // ★ reduced = 실제 추정 토큰 감소(개수 아님). L1/L2/L5 는 내용만 줄여 개수 유지 →
      //   개수 판정은 no-reduce 오판을 낳는다(breaker 폭발 근본). 토큰 감소로 정확 판정.
      const afterTokens = estimateMessagesTokens(compacted.messages);
      return {
        fired: true,
        messages: compacted.messages,
        reduced: afterTokens < beforeTokens,
        escalated,
        ratio: Number(decision.ratio.toFixed(2)),
        usedTokens: decision.usedTokens,
        beforeTokens,
        afterTokens,
      };
    },
  };
}
