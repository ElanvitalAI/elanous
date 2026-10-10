// ── Per-model system-prompt addons ──
//
// Ported from opencode's `session/system.ts` pattern (one `PROMPT_*`
// per provider family, selected at runtime based on the model id).
//
// Motivation: under identical skill + identical orchestration code,
// Claude Opus 4.6 completed stochastic-multi-agent-consensus
// correctly while gpt-5.4-codex looped — 12 back-to-back Read calls,
// 6 Data Collector re-spawns, zero reasoning text between turns. All
// three runtime guards (budget warning, synthesis rejection,
// consecutive-block throw) successfully MITIGATE the reflex loops
// but don't PREVENT them. The models that already follow instructions
// well (Claude family) need no addon; weaker tool-callers need an
// imperative discipline reminder appended to the skill's system
// prompt.
//
// Kept small + targeted: the addon only fires for provably weak
// tool-callers (codex / gpt-5 families). Claude / Gemini / Grok /
// local / auto get nothing — an extra paragraph there would bloat
// the prompt without benefit.

/** Compact family taxonomy. The return value drives both debug logs
 *  (so we can filter "which runs used which addon?") and the addon
 *  selector below. `null` = unknown model → no addon. */
export type ModelFamily =
  | 'claude'
  | 'gpt'
  | 'codex'
  | 'grok'
  | 'gemini'
  | 'local'
  | 'open-weight'
  | 'other';

/** OpenRouter gateway prefix for OpenAI-served models (see OR-FAMILY-GPT6 in getModelFamily). */
const OPENROUTER_OPENAI_PREFIX = 'openrouter/openai/';

/** Infer the family from a model id. Mirrors `inferProviderFromModel`
 *  in llm.ts but returns a finer-grained tag (codex vs other gpt,
 *  specifically, because codex-family has the worst observed tool-
 *  calling behaviour). The `gpt-5.4*` checks catch both the OpenAI
 *  `gpt-5.4` and the Codex `gpt-5.4-mini` variants. Unknown → 'other'. */
export function getModelFamily(modelId: string | undefined): ModelFamily {
  if (!modelId) return 'other';
  const m = modelId.toLowerCase();
  if (m.includes('claude')) return 'claude';
  if (m.includes('codex') || m.startsWith('gpt-5')) return 'codex';
  if (m.startsWith('gpt-') || m.startsWith('o1-') || m.startsWith('o3-') || m.startsWith('o4-')) return 'gpt';
  if (m.includes('grok')) return 'grok';
  if (m.startsWith('gemini-')) return 'gemini';
  if (m.startsWith('local:')) return 'local';
  // OR-FAMILY-GPT6 — `openrouter/openai/<gpt-* | o1-/o3-/o4-*>` is the same model the direct
  // path serves; when its bare id is 'gpt' there (gpt-6-*, gpt-4*, o-series) it gets 'gpt' here
  // too, so it carries the gpt prompt pieces (hygiene addon · preamble addendum · chat variant ·
  // tool-hint cap). Without this it fell to 'other'. ⛔ A 'codex' verdict (bare gpt-5*) is NOT
  // taken: in llm.ts 'codex' also switches tool-loop behaviour (inspect/repair stops, Read
  // auto-narrowing, exploration exemptions, idle timeout) — not just prompt text — and that is a
  // separate decision. Ids with `codex` in them were already 'codex' above. Gateway-prefixed ids
  // only — bare `openai/...` ids are not touched (same LM Studio reason as below).
  if (m.startsWith(OPENROUTER_OPENAI_PREFIX) && getModelFamily(m.slice(OPENROUTER_OPENAI_PREFIX.length)) === 'gpt') {
    return 'gpt';
  }
  // OpenRouter gateway ids only (`openrouter/<vendor>/<model>`). Bare vendor ids such as
  // `qwen/qwen3-coder-30b` stay 'other' on purpose: LM Studio publishes native ids in that
  // same shape (see getModelTier's local pattern), and this family must not reach local runs.
  if (m.startsWith('openrouter/') && (m.includes('glm') || m.includes('kimi') || m.includes('qwen'))) {
    return 'open-weight';
  }
  return 'other';
}

// ── Model tier (session 21) ─────────────────────────────────────────
//
// Coarse 3-tier classification used by the skill router to decide if
// the active model can handle a skill's declared `minTier`. Kept
// deliberately simple: we classify by STRING PATTERNS on the model id
// plus the provider hint — this is not a perfect capability model, but
// it gets us right answers for the common cases and we can hand-tune
// without restructuring when new models appear.
//
//   T1 (frontier) — top-of-line reasoning, tool use, long context:
//     claude-opus-4.x, claude-sonnet-4.x, gpt-5 / gpt-5.4 (non-mini),
//     o1/o3 full-size, grok-4.x, gemini-2.x-pro.
//   T2 (mini) — competent, cheaper, shorter context:
//     claude-haiku-*, claude-3-* (pre-4), gpt-5-mini, gpt-4o, o4-mini,
//     gemini-flash, grok-3-mini.
//   T3 (local) — anything under the `local` provider or `local:` id
//     prefix, plus community MLX/GGUF models (gemma/llama/qwen on
//     localhost).

import type { LLMProviderName } from '../user-config.js';
import type { SkillTier } from '../skills/skill-tier.js';
import { LLM_TIER_MAP_BY_PROVIDER, TIER_PROVIDERS } from '../model-tier/llm-tier-map.js';

function matchesAny(s: string, needles: string[]): boolean {
  for (const n of needles) if (s.includes(n)) return true;
  return false;
}

/** Classify the currently-active LLM into a tier. Unknown models
 *  default to T2 — conservative enough that a skill needing T1 won't
 *  auto-route silently, but not so cautious that everyone gets blocked. */
let frontierLadderCache: Set<string> | null = null;
/** shipping 사다리의 best·loaded 칸 모델(소문자). 사다리는 상수라 한 번만 만든다. */
function frontierLadderModels(): Set<string> {
  if (frontierLadderCache) return frontierLadderCache;
  const out = new Set<string>();
  for (const provider of TIER_PROVIDERS) {
    for (const tier of ['best', 'loaded'] as const) {
      const spec = LLM_TIER_MAP_BY_PROVIDER[provider][tier];
      if (spec.status === 'shipping') out.add(spec.model.toLowerCase());
    }
  }
  frontierLadderCache = out;
  return out;
}

export function getModelTier(
  provider: LLMProviderName | undefined,
  modelId: string | undefined,
): SkillTier {
  // Provider-driven overrides first. Local models never exceed T3.
  if (provider === 'local') return 'T3';

  const m = (modelId ?? '').toLowerCase();
  if (!m) return 'T2';

  // Explicit local-tag in the model id.
  if (m.startsWith('local:')) return 'T3';
  // ⛔ 2026-09-23 — 클라우드 게이트웨이 id(`openrouter/<vendor>/<model>`)는 «이름»에 `qwen` 이 있어도
  //   로컬이 아니다. 종전 패턴은 `openrouter/qwen/qwen3.8-max-0902`(클라우드 프런티어)를 T3 로 보냈다.
  const cloudGateway = provider === 'openrouter' || m.startsWith('openrouter/');
  // LM Studio / MLX / llama.cpp community pattern.
  if (!cloudGateway && matchesAny(m, ['mlx-community/', 'gguf', 'gemma', 'llama-', 'qwen'])) return 'T3';

  // ⭐ 2026-09-23 — T1 을 «이름 패턴»이 아니라 ***사다리에서 파생***한다: shipping 사다리의
  //   `best`·`loaded` 칸에 선 모델은 그 provider 의 프런티어다. 🩸 계기: GPT-6 이관(같은 날)이
  //   운영 기본 `gpt-6-sol` 을 T2 로 떨어뜨렸다 — 아래 패턴이 `gpt-5` 만 알아서, 사다리는 바꿨는데
  //   이 자리는 안 따라왔다(T1 스킬·전체 메뉴 라우팅이 조용히 막힘). 로컬 판정 «뒤»라 local 은 T3 그대로.
  if (frontierLadderModels().has(m)) return 'T1';

  // Frontier (T1) positive matches.
  if (matchesAny(m, ['opus', 'sonnet-4', 'sonnet4', 'claude-4'])) return 'T1';
  if (m.includes('gpt-5') && !m.includes('mini')) return 'T1';
  if (m.startsWith('o1-') || m.startsWith('o3-')) return 'T1';
  if (m.includes('grok-4')) return 'T1';
  // Gemini pro (frontier). Cover 2.x AND 3.x pro variants (2026 catalog:
  // gemini-3.1-pro-preview etc.) — the old list only knew 2.x, so 3.x pro
  // fell through to T2 and was wrongly blocked from T1-gated paths.
  if (/gemini-[23](\.\d+)?-pro/.test(m) || matchesAny(m, ['gemini-2-pro', 'gemini-2.0-pro', 'gemini-2.5-pro'])) return 'T1';

  // Mini (T2) positive matches — most smaller/cheaper models.
  if (matchesAny(m, ['haiku', 'mini', 'flash', 'nano'])) return 'T2';
  if (matchesAny(m, ['gpt-4', 'gpt-3.5'])) return 'T2';
  if (matchesAny(m, ['claude-3-5', 'claude-3.5', 'claude-3-haiku'])) return 'T2';
  if (matchesAny(m, ['grok-3', 'grok-2'])) return 'T2';

  return 'T2';   // safe default for unknowns
}

/** Minimal tool-call hygiene for older GPT/o-series models. Kept
 *  short and generic so stronger providers do not get burdened with
 *  Codex-specific anti-loop rules they do not need. */
const TOOL_DISCIPLINE_GPT = [
  '',
  '## Tool-call hygiene',
  '',
  '1. NEVER call the same tool with identical arguments twice in a row. If you already Read a file, use its previous tool_result from history — do not re-Read.',
  '2. After each tool_result, emit AT LEAST one sentence of reasoning (what you learned, what you will do next) BEFORE issuing the next tool call. Silent tool-spam is a failure mode we actively block.',
  '3. If any tool_result contains "DUPLICATE CALL", "RUNTIME BLOCKED", "TOOL CALL REJECTED", or "SYSTEM BUDGET NOTICE" — STOP. Your next output MUST be plain text (the final answer or a clear "impossible because X"), not another tool call.',
  '',
].join('\n');

/** Codex / GPT-5.x need stricter direction than older GPT models.
 *  Their common failure mode is read-only polling on stable state
 *  (Read / GetDashboardState / similar) instead of acting on the
 *  result they already have. Keep this focused on tool-loop hygiene,
 *  not orchestration prose. */
const TOOL_DISCIPLINE_CODEX = [
  '',
  '## Tool-call hygiene',
  '',
  '1. NEVER call the same tool with identical arguments twice in a row. If you already Read a file or inspected state, use the previous tool_result from history instead of polling again.',
  '2. Treat read-only state tools as stable within the current turn. Do NOT re-call a state-inspection tool unless an intervening action could have changed the state.',
  '3. After each tool_result, emit AT LEAST one sentence of reasoning (what you learned, what you will do next) BEFORE issuing the next tool call.',
  '4. If any tool_result contains "DUPLICATE CALL", "RUNTIME BLOCKED", "TOOL CALL REJECTED", or "SYSTEM BUDGET NOTICE" — STOP. Your next output MUST be plain text, not another tool call.',
  '',
].join('\n');

/** Return the discipline addon for the given model, or empty string
 *  if no addon applies. Callers concatenate this directly to their
 *  system prompt. Always safe to call + concat — empty string is a
 *  no-op. Logs the family choice via the debug tracer so forensic
 *  reviewers can see which addon was active for a given run. */
export function getModelPromptAddon(modelId: string | undefined): string {
  const family = getModelFamily(modelId);
  switch (family) {
    case 'codex':
      return TOOL_DISCIPLINE_CODEX;
    case 'gpt':
      return TOOL_DISCIPLINE_GPT;
    default:
      return '';
  }
}
