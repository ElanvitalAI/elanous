import { addRotationEntry } from '../user-config.js';
import type { LLMProviderName, RotationEntry, UserConfig } from '../user-config/types.js';

export interface DashboardProviderSetupOption {
  provider: LLMProviderName;
  label: string;
  description: string;
  /** Human-readable label for the API-key prompt + validator. */
  apiKeyLabel: string;
  /** Display label for the rotation entry. */
  rotationLabel: string;
  /** Setup branch:
   *  - 'apiKey'      classic API key prompt (anthropic / gemini / grok / openai)
   *  - 'codex'       OAuth-or-apikey-or-skip (delegates to popup wizard)
   *  - 'local'       4-runtime probe (delegates to popup wizard)
   *  - 'auto'        no key, just save provider:'auto' */
  flow: 'apiKey' | 'codex' | 'local' | 'auto';
}

export const DASHBOARD_PROVIDER_SETUP_OPTIONS: readonly DashboardProviderSetupOption[] = [
  {
    provider: 'anthropic',
    label: 'Anthropic',
    description: 'Claude · API key (ANTHROPIC_API_KEY)',
    apiKeyLabel: 'Anthropic API key',
    rotationLabel: 'Anthropic',
    flow: 'apiKey',
  },
  {
    provider: 'gemini',
    label: 'Google Gemini',
    description: 'Google · API key (GEMINI_API_KEY / GOOGLE_API_KEY)',
    apiKeyLabel: 'Google Gemini API key',
    rotationLabel: 'Google Gemini',
    flow: 'apiKey',
  },
  {
    provider: 'grok',
    label: 'Grok',
    description: 'xAI · API key (XAI_API_KEY / GROK_API_KEY)',
    apiKeyLabel: 'Grok API key',
    rotationLabel: 'Grok',
    flow: 'apiKey',
  },
  {
    provider: 'openai',
    label: 'OpenAI',
    description: 'OpenAI · API key (OPENAI_API_KEY)',
    apiKeyLabel: 'OpenAI API key',
    rotationLabel: 'OpenAI',
    flow: 'apiKey',
  },
  {
    provider: 'openai-codex',
    label: 'OpenAI Codex',
    description: 'ChatGPT OAuth or API key · runs in popup wizard',
    apiKeyLabel: 'OpenAI API key',
    rotationLabel: 'OpenAI Codex',
    flow: 'codex',
  },
  {
    provider: 'local',
    label: 'Local (Ollama / LM Studio)',
    description: 'OpenAI-compatible · auto-probe 4 runtimes (LOCAL_LLM_URL)',
    apiKeyLabel: 'Local LLM base URL',
    rotationLabel: 'Local LLM',
    flow: 'local',
  },
  {
    provider: 'auto',
    label: 'Auto-detect at runtime',
    description: 'Pick first available provider from env every call',
    apiKeyLabel: '',
    rotationLabel: 'Auto',
    flow: 'auto',
  },
  // Chinese cloud chat families · all OpenAI-compatible. Local
  // open-weight variants (e.g. qwen3.6:35b-a3b, glm-z1:32b) live
  // under the separate 'Local LLM' setup target.
  {
    provider: 'kimi',
    label: 'Kimi (Moonshot)',
    description: 'api.moonshot.cn · K2.6 1T MoE · vision · 256K ctx',
    apiKeyLabel: 'Moonshot Kimi API key',
    rotationLabel: 'Kimi',
    flow: 'apiKey',
  },
  {
    provider: 'qwen',
    label: 'Qwen (Alibaba)',
    description: 'DashScope intl · Qwen3.6 Max/Plus/Flash · 1M ctx',
    apiKeyLabel: 'DashScope API key',
    rotationLabel: 'Qwen',
    flow: 'apiKey',
  },
  {
    provider: 'glm',
    label: 'GLM (Zhipu)',
    description: 'Z.ai / BigModel · GLM-5.1 754B MoE · MIT open',
    apiKeyLabel: 'Zhipu / Z.ai API key',
    rotationLabel: 'GLM',
    flow: 'apiKey',
  },
] as const;

export function findProviderSetupOption(
  provider: string,
): DashboardProviderSetupOption | null {
  return DASHBOARD_PROVIDER_SETUP_OPTIONS.find((item) => item.provider === provider) ?? null;
}

export function getSavedProviderRotationEntry(
  cfg: UserConfig,
  provider: LLMProviderName,
): RotationEntry | null {
  const rotation = cfg.llm.rotation ?? [];
  const exact = rotation.find((entry) => entry.provider === provider && entry.apiKey);
  if (exact) return exact;
  if (cfg.llm.provider === provider && cfg.llm.apiKey) {
    return {
      provider,
      apiKey: cfg.llm.apiKey,
      label: findProviderSetupOption(provider)?.rotationLabel,
    };
  }
  return null;
}

export function applyDashboardProviderSetup(
  cfg: UserConfig,
  option: DashboardProviderSetupOption,
  apiKey: string,
): UserConfig {
  const withRotation = addRotationEntry(cfg, {
    provider: option.provider,
    apiKey,
    label: option.rotationLabel,
  });
  return {
    ...withRotation,
    llm: {
      ...withRotation.llm,
      provider: option.provider,
      apiKey,
      model: undefined,
      baseUrl: undefined,
    },
  };
}

