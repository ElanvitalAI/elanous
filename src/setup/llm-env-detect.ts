// LLM env-var auto-detect for /setup.
//
// Pure (env → detection) — no UI deps. Mirrors the env vars the
// runtime actually consumes in `src/config.ts`; if you add a new env
// fallback there, mirror it here so /setup recognizes it.
//
// Canonical map (provider → primary env var, with aliases):
//   - grok       XAI_API_KEY      (alias: GROK_API_KEY)        cf. config.ts:79
//   - openai     OPENAI_API_KEY                                cf. config.ts:87
//   - anthropic  ANTHROPIC_API_KEY                             cf. config.ts:90
//   - gemini     GEMINI_API_KEY   (alias: GOOGLE_API_KEY)      cf. config.ts:105
//   - local      LOCAL_LLM_URL    (base URL, not an API key)   cf. config.ts:92
//   - openai-codex shares OPENAI_API_KEY for apikey-mode       cf. onboarding.ts:431
//
// Auxiliary AI env vars (firecrawl/supadata/elevenlabs/…) are surfaced
// as info-only — they're consumed by skills/voice/web-search elsewhere
// in the runtime, not by the LLM picker.

import { debug } from '../debug/log.js';
import type { LLMProviderName } from '../user-config.js';

export type DetectableProvider = Exclude<LLMProviderName, 'auto'>;

export interface ProviderEnvSpec {
  provider: DetectableProvider;
  /** Env var the runtime reads first. */
  primaryKeyEnv: string;
  /** Additional env vars the runtime falls back to. */
  aliasKeyEnvs?: string[];
  /** Optional model-override env var (`<PROVIDER>_MODEL`). */
  modelEnv?: string;
  /** Optional base-URL env var (currently only `local`). */
  baseUrlEnv?: string;
  /** True when the provider needs a base URL instead of an API key
   *  (i.e. `local` reads `LOCAL_LLM_URL`). */
  baseUrlInsteadOfKey?: boolean;
}

export const PROVIDER_ENV_SPEC: readonly ProviderEnvSpec[] = [
  {
    provider: 'grok',
    primaryKeyEnv: 'XAI_API_KEY',
    aliasKeyEnvs: ['GROK_API_KEY'],
    modelEnv: 'GROK_MODEL',
  },
  {
    provider: 'openai',
    primaryKeyEnv: 'OPENAI_API_KEY',
    modelEnv: 'OPENAI_MODEL',
  },
  {
    provider: 'openai-codex',
    primaryKeyEnv: 'OPENAI_API_KEY',
  },
  {
    provider: 'anthropic',
    primaryKeyEnv: 'ANTHROPIC_API_KEY',
    modelEnv: 'ANTHROPIC_MODEL',
  },
  {
    provider: 'gemini',
    primaryKeyEnv: 'GEMINI_API_KEY',
    aliasKeyEnvs: ['GOOGLE_API_KEY'],
    modelEnv: 'GEMINI_MODEL',
  },
  {
    provider: 'local',
    primaryKeyEnv: 'LOCAL_LLM_URL',
    modelEnv: 'LOCAL_LLM_MODEL',
    baseUrlEnv: 'LOCAL_LLM_URL',
    baseUrlInsteadOfKey: true,
  },
  // 결정 2026-09-23 — 여섯째 «손 목록» 누락이었다(셋업·온보딩이 OPENROUTER_API_KEY 를 못 봤다).
  //   자 = `test/llm-provider-name-lists.test.ts`.
  {
    provider: 'openrouter',
    primaryKeyEnv: 'OPENROUTER_API_KEY',
    modelEnv: 'OPENROUTER_MODEL',
  },
  {
    provider: 'opengateway',
    primaryKeyEnv: 'OPENGATEWAY_API_KEY',
    modelEnv: 'OPENGATEWAY_MODEL',
  },
] as const;

export interface ProviderEnvDetection {
  provider: DetectableProvider;
  /** API key value (or base URL for `local`). Undefined when the
   *  primary + alias env vars are all empty. */
  value?: string;
  /** The env var the value came from (the source of truth). */
  source?: string;
  /** `<PROVIDER>_MODEL` value if exported. */
  modelOverride?: string;
  /** `LOCAL_LLM_URL` value when present (mirrors `value` for `local`). */
  baseUrlOverride?: string;
}

export type ProviderEnvDetectionMap = Record<DetectableProvider, ProviderEnvDetection>;

function readEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name];
  if (raw == null) return undefined;
  const trimmed = raw.trim();
  return trimmed ? trimmed : undefined;
}

/** Scan process env (or a test-supplied map) for canonical provider
 *  env vars. Returns one entry per detectable provider; when nothing
 *  is set, `value`/`source` are undefined (caller treats as "missing"). */
export function detectProviderEnvKeys(
  env: NodeJS.ProcessEnv = process.env,
): ProviderEnvDetectionMap {
  const out = {} as ProviderEnvDetectionMap;
  for (const spec of PROVIDER_ENV_SPEC) {
    const detection: ProviderEnvDetection = { provider: spec.provider };
    const primary = readEnv(env, spec.primaryKeyEnv);
    if (primary !== undefined) {
      detection.value = primary;
      detection.source = spec.primaryKeyEnv;
    } else if (spec.aliasKeyEnvs) {
      for (const alias of spec.aliasKeyEnvs) {
        const v = readEnv(env, alias);
        if (v !== undefined) { detection.value = v; detection.source = alias; break; }
      }
    }
    if (spec.modelEnv) {
      const m = readEnv(env, spec.modelEnv);
      if (m !== undefined) detection.modelOverride = m;
    }
    if (spec.baseUrlEnv) {
      const b = readEnv(env, spec.baseUrlEnv);
      if (b !== undefined) detection.baseUrlOverride = b;
    }
    out[spec.provider] = detection;
  }
  if (debug.enabled) {
    const found = Object.values(out)
      .filter(d => d.value)
      .map(d => `${d.provider}=${d.source}`);
    debug.log('setup.env-detect.scan', `found ${found.length}/${PROVIDER_ENV_SPEC.length}`, {
      detected: found,
      withModel: Object.values(out).filter(d => d.modelOverride).map(d => d.provider),
    });
  }
  return out;
}

/** Auxiliary (non-LLM) AI env vars the rest of the runtime consumes.
 *  Surfaced in /setup as an info line so the user knows elanous already
 *  picks them up — no action / no prompt. */
export interface AuxiliaryAiEnvVar {
  name: string;
  /** What this env var feeds in the runtime, in 1-3 words. */
  usedBy: string;
}

export const AUXILIARY_AI_ENV_VARS: readonly AuxiliaryAiEnvVar[] = [
  { name: 'FIRECRAWL_API_KEY',  usedBy: 'web-search' },
  { name: 'SUPADATA_API_KEY',   usedBy: 'youtube transcripts' },
  { name: 'ELEVENLABS_API_KEY', usedBy: 'voice TTS' },
  { name: 'BRAVE_API_KEY',      usedBy: 'web-search' },
  { name: 'YOUTUBE_API_KEY',    usedBy: 'youtube metadata' },
  { name: 'APIFY_TOKEN',        usedBy: 'X scraping' },
  { name: 'EODHD_API_KEY',      usedBy: 'market quotes' },
  { name: 'FDS_API_KEY',        usedBy: 'market quotes' },
  { name: 'UPSTAGE_API_KEY',    usedBy: 'document parse' },
] as const;

export function summarizeAuxiliaryAiEnv(
  env: NodeJS.ProcessEnv = process.env,
): AuxiliaryAiEnvVar[] {
  return AUXILIARY_AI_ENV_VARS.filter(v => readEnv(env, v.name) !== undefined);
}

/** Convenience: ordered list of providers that have an env-detected key
 *  (or base URL for `local`), in canonical-spec order. Useful for the
 *  picker's "Detect all" sweep + the entry-screen header summary. */
export function listEnvDetectedProviders(
  detection: ProviderEnvDetectionMap,
): DetectableProvider[] {
  return PROVIDER_ENV_SPEC
    .map(spec => spec.provider)
    .filter(p => detection[p]?.value !== undefined);
}
