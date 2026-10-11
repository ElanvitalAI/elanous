// OR-BYOK-COST (2026-10-11) — OpenRouter BYOK(Bring Your Own Key) 호출의 «실비용»을 원장에 싣는다.
//
// S: OpenRouter 계정에 상류 키(예: OpenAI)가 붙어 있으면 그 호출은 BYOK 로 라우팅된다. 응답 `usage` 는
//    `is_byok: true` · `cost: 0`(OR 청구) · `cost_details.upstream_inference_cost: <USD>`(상류 키로 실제 청구)로 온다
//    (UX 실측 10-11 · `openai/gpt-6-luna` · provider=OpenAI).
// C: elanous 는 `usage.cost` 만 읽었다 ⇒ BYOK 실비용이 원장(`usdKnown`)에서 사라지고 벤치·롤업 $ 가 0 으로 낮게 잡혔다.
// A: 파서가 `is_byok` ⊕ `upstream_inference_cost` 를 읽고(이 모듈), 비용 판정이 «OR 청구 + 상류 청구»를
//    `kind:'actual'` 로 낸다(출처 `costSource:'byok-upstream'` 와 두 몫을 곁에 남긴다).
//    ⛔ 상류 칸이 없거나 숫자가 아니면 «미상» — 0 으로 가정하지 않는다(`kind:'partial'` · 롤업이 unknownCostCalls 로 센다).

import { debug } from '../debug/log.js';

/** 파서가 `LLMUsage` 에 더하는 BYOK 칸. 비-BYOK 응답이면 «빈 객체»(종전 바이트 그대로). */
export interface OpenRouterByokUsageFields {
  /** OpenRouter `usage.is_byok === true` — 상류 키로 청구된 호출. */
  byok?: true;
  /** OpenRouter `usage.cost_details.upstream_inference_cost` — 상류 키로 실제 청구된 USD. 칸이 없거나 숫자가 아니면 없다(=미상). */
  upstreamCostUsd?: number;
}

function finiteNonNegative(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/** OpenAI 호환 응답(스트림 마지막 청크 · 비스트림 본문 모두 `usage` 가 최상위에 있다)에서 BYOK 칸을 읽는다.
 *  ⛔ 관측에 키 값을 넣지 않는다 — 모델·상류 provider·금액만. */
export function readOpenRouterByokUsage(event: unknown): OpenRouterByokUsageFields {
  if (!event || typeof event !== 'object') return {};
  const e = event as { usage?: unknown; model?: unknown; provider?: unknown };
  const u = e.usage;
  if (!u || typeof u !== 'object') return {};
  const r = u as { is_byok?: unknown; cost_details?: unknown };
  if (r.is_byok !== true) return {};
  const details = r.cost_details && typeof r.cost_details === 'object' ? r.cost_details as { upstream_inference_cost?: unknown } : undefined;
  const upstream = details?.upstream_inference_cost;
  const out: OpenRouterByokUsageFields = { byok: true };
  if (finiteNonNegative(upstream)) out.upstreamCostUsd = upstream;
  try {
    debug.log('llm.openrouter', 'byok-cost', {
      model: typeof e.model === 'string' ? e.model : null,
      provider: typeof e.provider === 'string' ? e.provider : null,
      upstreamCostUsd: out.upstreamCostUsd ?? null,
    });
  } catch { /* 관측 실패가 파싱을 바꾸지 않는다 */ }
  return out;
}

/** 스트림 합산(`accumulateUsage`)용 — BYOK 표지는 «한 번이라도» 참이면 참, 상류 금액은 더한다. */
export function accumulateByokUsage<T extends OpenRouterByokUsageFields>(total: T, received: OpenRouterByokUsageFields): T {
  if (received.byok === true) total.byok = true;
  if (received.upstreamCostUsd !== undefined) total.upstreamCostUsd = (total.upstreamCostUsd ?? 0) + received.upstreamCostUsd;
  return total;
}

/** BYOK 호출의 비용 칸. 두 몫(OR 청구 · 상류 청구)을 모두 알면 `actual`, 하나라도 모르면 `partial`(알려진 몫만 usd). */
export interface ByokActualCost {
  kind: 'actual';
  model: string;
  /** OR 청구 + 상류 청구. */
  usd: number;
  source: 'provider-reported';
  costSource: 'byok-upstream';
  byok: true;
  orChargeUsd: number;
  upstreamUsd: number;
  estimateUsd?: number;
}

export interface ByokPartialCost {
  kind: 'partial';
  model: string;
  /** 알려진 몫만(대개 OR 청구 0). 모르는 몫은 null 칸으로 표시한다 — 롤업은 이 호출을 unknownCostCalls 로 센다. */
  usd: number;
  source: 'provider-reported';
  costSource: 'byok-upstream';
  byok: true;
  orChargeUsd: number | null;
  upstreamUsd: number | null;
  estimateUsd?: number;
}

/** BYOK 이면 비용 칸을 낸다 — 비-BYOK 이면 null(호출부가 종전 경로로 간다). */
export function byokCostFor(
  model: string,
  usage: { byok?: unknown; upstreamCostUsd?: unknown; reportedCostUsd?: unknown },
  estimateUsd: number | undefined,
): ByokActualCost | ByokPartialCost | null {
  if (usage.byok !== true) return null;
  const or = finiteNonNegative(usage.reportedCostUsd) ? usage.reportedCostUsd : null;
  const up = finiteNonNegative(usage.upstreamCostUsd) ? usage.upstreamCostUsd : null;
  const est = estimateUsd !== undefined ? { estimateUsd } : {};
  if (or !== null && up !== null) {
    return { kind: 'actual', model, usd: or + up, source: 'provider-reported', costSource: 'byok-upstream', byok: true, orChargeUsd: or, upstreamUsd: up, ...est };
  }
  return { kind: 'partial', model, usd: (or ?? 0) + (up ?? 0), source: 'provider-reported', costSource: 'byok-upstream', byok: true, orChargeUsd: or, upstreamUsd: up, ...est };
}
