// ── Codex-first route decision read-model (R0 · 2026-07-15) ────────────────
//
// This is deliberately not another router.  It makes the decision already
// made by the active provider + MissionRouter Tier-1 classification readable
// by every surface that needs to explain it (turn footer, mission briefing,
// later trace/ACP consumers).  Callers still own execution and must preserve
// an explicit model pin.

import type { LLMProviderName, ReasoningLevel, LlmRoutePolicyConfig } from '../user-config.js';
import { classifyMissionTier1, type MissionKind } from './mission-router.js';
import type { SessionSource } from '../session/index.js';
import { lookupLlmTierSpec } from '../model-tier/llm-tier-map.js';

export type RouteDecisionSource = 'explicit-pin' | 'codex-tier-policy' | 'legacy-default' | 'active-provider-default' | 'execution-backend';

/** Minimal cross-surface record.  `mission` is classification only: it does
 * not authorize the legacy mission-router provider map to replace the active
 * provider. */
export interface RouteDecision {
  provider: LLMProviderName;
  model: string;
  effort?: ReasoningLevel;
  source: RouteDecisionSource;
  rationale: string;
  mission: MissionKind;
  escalation?: { reason: string; attempt?: number };
}

/** Compact, surface-neutral text for essential TUI/footer/trace. */
export function formatRouteDecisionSummary(decision: RouteDecision): string {
  const effort = decision.effort ? ` · ${decision.effort}` : '';
  const escalation = decision.escalation
    ? ` · escalation ${decision.escalation.reason}${decision.escalation.attempt ? ` #${decision.escalation.attempt}` : ''}`
    : '';
  return `${decision.provider}/${decision.model}${effort} · ${decision.source}${escalation} — ${decision.rationale}`;
}

/** Process-local current decision for an interactive surface. This is not
 * mission evidence; R3's TaskStore note remains the durable record. */
const lastBySurface = new Map<string, RouteDecision>();

export function recordCurrentRouteDecision(surface: string, decision: RouteDecision): void {
  lastBySurface.set(surface, decision);
  // 새 턴의 결정이 서면 지난 턴의 «실제 실행»은 더는 이 턴의 것이 아니다.
  executionBySurface.delete(surface);
}

export function currentRouteDecision(surface: string): RouteDecision | null {
  return lastBySurface.get(surface) ?? null;
}

/** 이번 턴에 «실제로» 응답한 공급자·모델(TUI-MODEL-BADGE-ACTUAL · 10-16).
 *  결정(`RouteDecision`)은 턴 «시작»에 고른 값이고, 폴백 체인이 다른 공급자로 넘기면 실제는 달라진다.
 *  ACP 사용량 봉투(`routeProvider`·`model`)로 들어온다 — 이 표면이 결정을 세운 in-process 세션만 적는다.
 *  ⚠️ 지금 읽는 곳은 완료 배지뿐이다. 상태줄·`/model` «지금:» 의 원천 통일은 후속 칸 TUI-MODEL-BADGE-SOURCE. */
export interface RouteExecution {
  provider?: string;
  model: string;
}

const executionBySurface = new Map<string, RouteExecution>();

export function recordRouteExecution(surface: string, execution: RouteExecution): void {
  executionBySurface.set(surface, execution);
}

export function currentRouteExecution(surface: string): RouteExecution | null {
  return executionBySurface.get(surface) ?? null;
}

/** 표면의 결정·실행을 비운다(세션 핀은 사람의 선택이라 남긴다) — 짝이 안 맞는 턴(원격 등)에서 지난 «A → B» 가
 *  다시 보이지 않게 한다(r5 리뷰). */
export function clearSurfaceRouteDecision(surface: string): void {
  lastBySurface.delete(surface);
  executionBySurface.delete(surface);
}

/** 턴이 고른 모델과 실제로 응답한 모델이 다르면 «처음 → 실제», 아니면 null(꾸미지 않는다). */
export function routeFallbackLabel(surface: string): string | null {
  const decision = lastBySurface.get(surface);
  const execution = executionBySurface.get(surface);
  if (!decision?.model || !execution?.model || execution.model === decision.model) return null;
  return `${decision.model} → ${execution.model}`;
}

/** A `/model` choice scoped to this process's surface (TUI-MODEL-SESSION-SCOPE · 10-14).
 * It reaches the turn as `explicitModel`, so it wins over the Codex tier policy —
 * a config-only `llm.model` change is ignored by that policy (10-14 OPT: `/model luna`
 * wrote config, every turn still ran sol). Not persisted; `/model … --global` writes config. */
export interface SessionModelPin {
  provider: LLMProviderName;
  model: string;
}

const pinBySurface = new Map<string, SessionModelPin>();

export function setSessionModelPin(surface: string, pin: SessionModelPin | null): void {
  if (pin) pinBySurface.set(surface, pin);
  else pinBySurface.delete(surface);
}

/** The surface's pinned model, or null when none — or when the active provider
 * has since changed (a pin only makes sense on the provider it was chosen for). */
export function sessionModelPin(surface: string, activeProvider?: LLMProviderName): SessionModelPin | null {
  const pin = pinBySurface.get(surface);
  if (!pin) return null;
  if (activeProvider !== undefined && pin.provider !== activeProvider) return null;
  return pin;
}

export interface ResolveRouteDecisionInput {
  provider: LLMProviderName;
  configuredModel?: string;
  text: string;
  /** Telegram keeps its non-deep coding tier; other surfaces retain the configured quick model. */
  surface?: SessionSource;
  /** A per-turn/slash/user model choice.  It always wins. */
  explicitModel?: string;
  routePolicy?: LlmRoutePolicyConfig;
}

/** Pure current-lane resolver.  The Codex subscription policy is encoded only
 * for an active Codex provider: deep intents (plan/review) take the `best`
 * tier, everything else takes the `better` (coding) tier.  Other providers
 * remain untouched instead of following the legacy mission provider
 * recommendation.
 *
 * ⛔⭐⭐ 2026-09-23 (대표) — ***이 함수는 모델 이름을 «모른다». 그렇게 유지한다.***
 *   종전엔 로직은 티어였는데 ***rationale 문면이 `terra` 를 박고 있었다***. 그래서 사다리가
 *   GPT-6 으로 옮겨간 뒤에도 로그·관측이 «terra» 라고 말했다 — 값은 맞고 «말»이 틀린 상태.
 *   ⇒ 이제 rationale 을 `lookupLlmTierSpec` 의 `label` 에서 «파생»시킨다. 사다리를 바꾸면
 *     문면이 «같이» 바뀌고, 이름을 다시 박을 자리가 없다.
 *
 * ⭐ 코딩 레인은 `balanced`(low) 가 아니라 **`better`(medium)** 다 (대표 2026-09-23).
 *   근거: ⑴ 대표 지시 *"전체 기본값을 gpt6 sol medium"* ⑵ 커뮤니티 실측 —
 *   *"agentic coding is explicitly called out as sitting well at **medium**"* ⊕
 *   벤치에서 medium 이 test pass rate·code-review score 로 «정점». ⛔ high 이상은
 *   과잉설계·scope creep 신고가 급증하므로 deep(plan/review) 에만 둔다. */
export function resolveRouteDecision(input: ResolveRouteDecisionInput): RouteDecision {
  const mission = classifyMissionTier1({ text: input.text }).mission;
  if (input.explicitModel) {
    return {
      provider: input.provider,
      model: input.explicitModel,
      source: 'explicit-pin',
      rationale: 'explicit per-turn model pin preserved',
      mission,
    };
  }
  const policyMode = input.routePolicy?.mode;
  // Unspecified callers keep the configured quick model for compatibility; Telegram alone owns the coding-tier exception.
  if (input.provider === 'openai-codex' && input.surface !== 'telegram' && policyMode === undefined && mission === 'quick' && input.configuredModel) {
    return {
      provider: input.provider,
      model: input.configuredModel,
      source: 'active-provider-default',
      rationale: 'configured model preserved for quick mission',
      mission,
    };
  }
  if (input.provider === 'openai-codex' && policyMode !== 'active-provider') {
    const deep = mission === 'plan' || mission === 'review';
    const tier = deep ? 'best' : 'better';
    const spec = lookupLlmTierSpec('openai-codex', tier);
    const lane = policyMode === 'codex-first' ? 'Codex-first' : 'legacy';
    return {
      provider: input.provider,
      model: spec.model,
      ...(spec.reasoningLevel ? { effort: spec.reasoningLevel } : {}),
      source: policyMode === 'codex-first' ? 'codex-tier-policy' : 'legacy-default',
      // ⛔ 모델 이름을 «쓰지 않는다» — 티어와 그 티어의 label 에서 파생시킨다(위 머리말).
      rationale: deep
        ? `${lane} deep ${mission}: ${tier} tier (${spec.label})`
        : `${lane} ${mission}: ${tier} coding tier (${spec.label})`,
      mission,
    };
  }
  return {
    provider: input.provider,
    model: input.configuredModel ?? '',
    source: 'active-provider-default',
    rationale: 'active provider preserved; mission classification does not switch provider',
    mission,
  };
}
