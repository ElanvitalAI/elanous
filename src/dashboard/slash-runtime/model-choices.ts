// TUI-SLASH-DECIDE-NOW C · 2026-10-07 — `/model` offered only code names (terra·sol·luna…), so a first
// user had nothing to choose by (F14). Three human words now sit in front: 빠름·보통·깊음 resolve to
// the CURRENT provider's budget·better·best tiers via `lookupLlmTierSpec` (no hard-coded model ids).
// The seven code names keep going to the same model and provider as before.
// A tier is «model ⊕ reasoning level» — on several ladders better and best share a model and differ only
// in reasoning (codex gpt-6-sol medium/high · opus medium/medium), so a human word also carries the tier's
// reasoning level; otherwise 보통 and 깊음 would be the same choice. Code names leave reasoning alone.
import type { LLMProviderName, ReasoningLevel } from '../../user-config.js';
import { lookupLlmTierSpec } from '../../model-tier/index.js';
import type { ModelTier } from '../../model-tier/types.js';

export interface ModelTarget {
  readonly model: string;
  readonly provider: LLMProviderName;
}

// 명시 target 맵(id + provider) — catalog/prefix 추론 대신 확정값. 핵심:
// Codex 계열(gpt-5.5/5.6-sol/terra/luna)은 gpt- prefix 라 자동 추론은
// 'openai'(Chat Completions)로 오분류하나, 실제론 Responses API 필수라
// provider=openai-codex 여야 한다(omni-crawl 2026-07-17 확인). GPT(openai·
// Chat Completions)는 노출하지 않는다(대표 지시 — 혼란 방지·codex만).
// 비-OpenAI fallback 은 claude(anthropic)·grok.
export const MODEL_TARGETS: Readonly<Record<string, ModelTarget>> = {
  codex:  { model: 'gpt-5.5',        provider: 'openai-codex' },
  // 🩸 2026-09-23 — GPT-6 에는 terra 가 없다(결정). 별칭은 남기되 codex 사다리 better 칸(sol 한 칸 아래 자리)을 가리킨다.
  terra:  { model: lookupLlmTierSpec('openai-codex', 'better').model, provider: 'openai-codex' },
  sol:    { model: lookupLlmTierSpec('openai-codex', 'best').model, provider: 'openai-codex' },
  luna:   { model: lookupLlmTierSpec('openai-codex', 'budget').model, provider: 'openai-codex' },
  opus:   { model: 'claude-opus-4-8',   provider: 'anthropic' },
  sonnet: { model: 'claude-sonnet-5', provider: 'anthropic' },
  // ⭐ 티어 표를 따른다(옆 luna 와 같은 형태) — 하드코딩이면 표를 바꿔도 «안 따라온다»(2026-08-18 대표 4.6 재편)
  grok:   { model: lookupLlmTierSpec('grok', 'best').model, provider: 'grok' },
};

export const MODEL_CODE_NAMES: readonly string[] = Object.keys(MODEL_TARGETS);

export interface HumanModelChoice {
  readonly word: '빠름' | '보통' | '깊음';
  readonly english: 'fast' | 'normal' | 'deep';
  readonly tier: ModelTier;
}

export const HUMAN_MODEL_CHOICES: readonly HumanModelChoice[] = [
  { word: '빠름', english: 'fast', tier: 'budget' },
  { word: '보통', english: 'normal', tier: 'better' },
  { word: '깊음', english: 'deep', tier: 'best' },
];

export const HUMAN_MODEL_WORDS: readonly string[] = HUMAN_MODEL_CHOICES.map(({ word }) => word);

export type ModelChoiceResolution =
  | { readonly kind: 'human'; readonly word: HumanModelChoice['word']; readonly tier: ModelTier; readonly target: ModelTarget; readonly reasoningLevel?: ReasoningLevel }
  | { readonly kind: 'code'; readonly name: string; readonly target: ModelTarget }
  /** A human word while the provider is `auto` — there is no single ladder to read. */
  | { readonly kind: 'needs-provider'; readonly word: HumanModelChoice['word'] }
  | { readonly kind: 'unknown'; readonly arg: string };

/** Resolve a `/model` argument against the provider that is active right now. */
export function resolveModelChoice(rawArg: string, currentProvider: LLMProviderName): ModelChoiceResolution {
  const arg = rawArg.trim().toLowerCase();
  const human = HUMAN_MODEL_CHOICES.find(({ word, english }) => arg === word || arg === english);
  if (human) {
    if (currentProvider === 'auto') return { kind: 'needs-provider', word: human.word };
    const spec = lookupLlmTierSpec(currentProvider, human.tier);
    return {
      kind: 'human', word: human.word, tier: human.tier, target: { model: spec.model, provider: currentProvider },
      ...(spec.reasoningLevel ? { reasoningLevel: spec.reasoningLevel } : {}),
    };
  }
  const target = MODEL_TARGETS[arg];
  if (target) return { kind: 'code', name: arg, target };
  return { kind: 'unknown', arg };
}

/**
 * The human word for (`model`, `reasoning`) on `provider`: an exact tier match first; without a reasoning
 * level (or no exact match) only a model that names a single tier counts — an ambiguous model gets no word.
 */
export function humanWordForModel(
  provider: LLMProviderName,
  model: string | undefined | null,
  reasoning?: ReasoningLevel,
): HumanModelChoice['word'] | undefined {
  if (!model || provider === 'auto') return undefined;
  const sameModel = HUMAN_MODEL_CHOICES.filter(({ tier }) => lookupLlmTierSpec(provider, tier).model === model);
  if (reasoning) {
    const exact = sameModel.find(({ tier }) => {
      const level = lookupLlmTierSpec(provider, tier).reasoningLevel;
      return level === undefined || level === reasoning;
    });
    if (exact) return exact.word;
  }
  return sameModel.length === 1 ? sameModel[0]!.word : undefined;
}

function currentLabel(provider: LLMProviderName, model: string | undefined | null, reasoning?: ReasoningLevel): string {
  return humanWordForModel(provider, model, reasoning) ?? (model?.trim() || '기본 모델');
}

/** `/model` with no argument: the current choice, then how to choose. The second line is muted by the caller. */
export function modelOverviewLines(
  provider: LLMProviderName,
  model: string | undefined | null,
  reasoning?: ReasoningLevel,
): [string, string] {
  const word = humanWordForModel(provider, model, reasoning);
  const now = word ? `${word} (${model})` : (model?.trim() || '기본 모델');
  return [
    `지금: ${now} · 고르기: /model ${HUMAN_MODEL_WORDS.join(' | ')}`,
    `  코드명도 됨: ${MODEL_CODE_NAMES.join(' · ')}  ·  provider ${provider}  ·  생각 깊이: /reasoning`,
  ];
}

/** Confirmation after a switch: «보통 → 깊음 (<model>)». */
export function modelChangeLine(
  before: { provider: LLMProviderName; model: string | undefined | null; reasoning?: ReasoningLevel },
  resolution: Extract<ModelChoiceResolution, { kind: 'human' | 'code' }>,
): string {
  const after = resolution.kind === 'human'
    ? resolution.word
    : humanWordForModel(resolution.target.provider, resolution.target.model) ?? resolution.name;
  const reasoningNote = resolution.kind === 'human' && resolution.reasoningLevel ? ` · 생각 ${resolution.reasoningLevel}` : '';
  const providerNote = resolution.target.provider === before.provider ? '' : `  · provider ${resolution.target.provider}`;
  return `모델: ${currentLabel(before.provider, before.model, before.reasoning)} → ${after} (${resolution.target.model}${reasoningNote})${providerNote}`;
}
