// ── OpenAI Codex model catalog ──
//
// Curated subset of the full OpenAI Codex CLI model roster, covering
// common use cases without overwhelming the onboarding picker. Source: omni-crawl sweep on 2026-04-14 across
//   - developers.openai.com/api/docs/models/{all,codex-mini-latest,gpt-5-codex}
//   - developers.openai.com/codex/models
//   - platform.openai.com/docs/models
//   - openai.com/index/{introducing-gpt-5-3-codex,introducing-gpt-5-2-codex}
//   - simonwillison.net/2025/Nov/9/gpt-5-codex-mini (community observations)
//
// The Codex CLI honors the OpenAI `/v1/models` list, so any id OpenAI
// ships will Just Work — this catalog is a CURATED starting point
// for the wizard, not an enumeration. Users who want something else
// can type a custom id at the prompt.
//
// Refresh cadence: re-run `omni-crawl` when the upstream roster shifts
// and update both the entries below and the MANUAL.md snapshot.
//
// 2026-09-09 refresh (live 1차 대조 — developers.openai.com/api/내부 문서 `gpt-6-astra`
// ⊕ openai.com/api/pricing/ ⊕ `codex exec --model gpt-6-astra` 실호출):
//   + gpt-6-astra  (2026-09-03 출시 · 현 최상단)
//   + gpt-5.6-terra (at the time, the configured `llm.model` default)
// GPT-6.1 refresh (2026-10-28): recommended is GPT-6.1 Terra; Sol is available for higher-cost deep work.
// `recommended` means a safe default, not the strongest model; Astra remains opt-in due to its higher cost.

export type CodexModelTier = 'flagship' | 'balanced' | 'cheap' | 'specialist' | 'legacy';

export interface CodexModel {
  id: string;
  /** Human-friendly label for the picker. */
  label: string;
  tier: CodexModelTier;
  /** One-line elevator pitch. */
  description: string;
  /** Context window (tokens). null when not publicly specified. */
  contextWindow: number | null;
  /** Approximate pricing in USD per M input / M output tokens.
   *  Informational only; actual billing comes from OpenAI. */
  pricingUsd: { inputPerM: number; outputPerM: number; cacheReadPerM?: number } | null;
  /** Shown as the default pick in the wizard when true. Exactly one
   *  model should be marked recommended at any time. */
  recommended?: boolean;
}

/** Curated models for the 1-point setup picker. Ordering reflects the UI:
 *  recommended first, then by descending tier. */
export const CODEX_MODELS: CodexModel[] = [
  {
    id: 'gpt-6.1-terra',
    label: 'GPT-6.1 Terra',
    tier: 'balanced',
    description: 'Recommended everyday Codex model. 500K context; $1/$5 per million tokens, cached input $0.05.',
    contextWindow: 500_000,
    pricingUsd: { inputPerM: 1.0, outputPerM: 5.0, cacheReadPerM: 0.05 },
    recommended: true,
  },
  {
    // Cache-read rates: Astra $1.00/M, GPT-6.1 Sol $0.10/M, Terra $0.05/M, Luna $0.01/M.
    // Per OP 2026-10-28 price direction, legacy GPT-6 Sol also uses $0.10/M for cost estimates.
    id: 'gpt-6-astra',
    label: 'GPT-6 Astra (frontier)',
    tier: 'flagship',
    description: 'Newest frontier model (2026-09-03). Best-in-class coding + computer use + frontend work; 1.05M context, reasoning effort low..max. Expensive — pick deliberately, not by default.',
    contextWindow: 1_050_000,
    pricingUsd: { inputPerM: 10.0, outputPerM: 50.0, cacheReadPerM: 1.0 },
  },
  {
    id: 'gpt-6.1-sol',
    label: 'GPT-6.1 Sol',
    tier: 'flagship',
    description: 'Higher-capability reasoning and coding model. 500K context; $2/$10 per million tokens, cached input $0.10.',
    contextWindow: 500_000,
    pricingUsd: { inputPerM: 2.0, outputPerM: 10.0, cacheReadPerM: 0.1 },
  },
  {
    id: 'gpt-6-sol',
    label: 'GPT-6 Sol',
    tier: 'legacy',
    description: 'Legacy GPT-6 Sol retained for compatibility; GPT-6.1 Sol is its higher-performing successor at the same price, while Terra is a lower-cost default.',
    contextWindow: 1_050_000,
    pricingUsd: { inputPerM: 2.0, outputPerM: 10.0, cacheReadPerM: 0.1 },
  },
  {
    id: 'gpt-6-luna',
    label: 'GPT-6 Luna (cheapest)',
    tier: 'cheap',
    description: 'Focused·high-volume 용 최저가. 5.6 Luna 대비 input 1/10 · output 1/12 인데 추론은 «High». 1.05M ctx, effort none..max.',
    contextWindow: 1_050_000,
    pricingUsd: { inputPerM: 0.1, outputPerM: 0.5, cacheReadPerM: 0.01 },
  },
  {
    id: 'gpt-5.6-terra',
    label: 'GPT-5.6 Terra (balanced)',
    tier: 'balanced',
    description: 'elanous default coding driver — fastest reliable agentic coding in the 2026-07-11 tuning matrix. 1M context, effort minimal..high.',
    contextWindow: 1_050_000,
    pricingUsd: { inputPerM: 2.0, outputPerM: 12.0 },
  },
  {
    id: 'gpt-5.5',
    label: 'GPT-5.5 (flagship)',
    tier: 'flagship',
    description: 'Latest flagship — top-tier reasoning + coding, large context, native tool use. Recommended default for monad-agent sessions.',
    contextWindow: 400_000,
    pricingUsd: { inputPerM: 2.5, outputPerM: 10.0 },
  },
  {
    id: 'gpt-5.4-mini',
    label: 'GPT-5.4 Mini',
    tier: 'balanced',
    description: 'Sweet-spot for everyday coding + chat. Fast, cheap, 400K context.',
    contextWindow: 400_000,
    pricingUsd: { inputPerM: 0.75, outputPerM: 3.0 },
  },
  {
    id: 'gpt-5.4',
    label: 'GPT-5.4 (flagship)',
    tier: 'flagship',
    description: 'Prior flagship — 1M-token context, native tool use. Pick when 5.5 is unavailable.',
    contextWindow: 1_000_000,
    pricingUsd: { inputPerM: 2.5, outputPerM: 10.0 },
  },
  {
    id: 'gpt-5-codex',
    label: 'GPT-5 Codex',
    tier: 'specialist',
    description: 'Coding-tuned GPT-5 variant. Best at agentic tasks + SWE-bench (~72% accuracy). Use for heavy refactor / multi-file edits.',
    contextWindow: 400_000,
    pricingUsd: { inputPerM: 1.25, outputPerM: 5.0 },
  },
];

/** Fallback when no recommended flag is set (shouldn't happen given
 *  the assertion test, but defensive.) */
export function defaultCodexModel(): CodexModel {
  return CODEX_MODELS.find(m => m.recommended) ?? CODEX_MODELS[0];
}

/** Lookup by id (returns undefined for custom/unknown). */
export function findCodexModel(id: string): CodexModel | undefined {
  return CODEX_MODELS.find(m => m.id === id);
}

/** Short tier badge for listings. */
export function tierBadge(tier: CodexModelTier): string {
  switch (tier) {
    case 'flagship':   return '★ flagship';
    case 'balanced':   return '⚖ balanced';
    case 'cheap':      return '¢ cheap';
    case 'specialist': return '⚒ specialist';
    case 'legacy':     return '⌛ legacy';
  }
}

/** Render a picker-ready multi-line block for one model. Used by the
 *  onboarding wizard and `elanous codex models` listing. */
export function renderModelEntry(m: CodexModel, index: number): string {
  const rec = m.recommended ? ' [recommended]' : '';
  const ctx = m.contextWindow ? `${Math.round(m.contextWindow / 1000)}K ctx` : 'ctx: n/a';
  const price = m.pricingUsd
    ? `$${m.pricingUsd.inputPerM}/M in · $${m.pricingUsd.outputPerM}/M out`
    : 'pricing: n/a';
  return [
    `  ${index}) ${m.label}  —  ${tierBadge(m.tier)}${rec}`,
    `     id: ${m.id}    ${ctx}    ${price}`,
    `     ${m.description}`,
  ].join('\n');
}

export function renderAllModels(): string {
  return CODEX_MODELS.map((m, i) => renderModelEntry(m, i + 1)).join('\n\n');
}
