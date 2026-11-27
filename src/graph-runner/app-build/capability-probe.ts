// APP-BUILD-CAPABILITY-RESOLUTION — the host side: what eln already has (probe, names only) and the run-time
// env for a generated app (the only place a key value is read, straight into the child process env).

import { mockEnvName, type CapabilityKeyRef, type CapabilityProbe, type CapabilityResolution } from './capability-resolution.js';

/** Providers an app can call with a plain OpenAI-compatible HTTP adapter (key = Bearer). */
async function providerEndpoints(): Promise<Record<string, string>> {
  const config = await import('../../config.js');
  const { ZAI_CODING_PLAN_URL } = await import('../../llm/zai-coding-plan.js');
  const root = (url: string) => url.replace(/\/chat\/completions$/u, '');
  return {
    openrouter: root(config.OPENROUTER_API_URL), openai: root(config.OPENAI_API_URL), gemini: root(config.GEMINI_API_URL),
    grok: root(config.GROK_API_URL), opengateway: root(config.OPENGATEWAY_API_URL), glm: root(ZAI_CODING_PLAN_URL),
  };
}

/** Wire model id for a provider (catalog ids carry an `openrouter/` prefix the API does not take). */
function wireModel(provider: string, model: string): string {
  return provider === 'openrouter' ? model.replace(/^openrouter\//u, '') : model;
}

export interface CapabilityProbeDeps {
  readConfig?: () => import('../../user-config/types.js').UserConfig;
  /** Resolve the running provider name for an `auto` config. */
  resolveProviderName?: (config: import('../../user-config/types.js').UserConfig) => Promise<{ name: string; defaultModel: string }>;
  /** True when a credential for the provider resolves (value is dropped immediately). */
  providerHasKey?: (provider: string, config: import('../../user-config/types.js').UserConfig) => Promise<boolean>;
  listSecretNames?: () => Promise<string[]>;
  env?: NodeJS.ProcessEnv;
  which?: (tool: string) => string | null;
}

async function defaultProviderHasKey(provider: string, config: import('../../user-config/types.js').UserConfig): Promise<boolean> {
  if (provider === 'local') return true;
  if (provider === 'glm') return (await import('../../llm/zai-coding-plan.js')).zaiCodingPlanAvailable();
  return !!(await providerApiKey(provider, config));
}

async function providerApiKey(provider: string, config: import('../../user-config/types.js').UserConfig): Promise<string | undefined> {
  if (provider === 'glm') return (await import('../../llm/zai-coding-plan.js')).getZaiApiKey();
  const { resolveProviderCredentialAsync } = await import('../../llm/provider-credentials.js');
  const resolved = await resolveProviderCredentialAsync({ provider, rotation: config.llm.rotation,
    baseApiKey: config.llm.apiKey, baseProvider: config.llm.provider });
  if (resolved.apiKey) return resolved.apiKey;
  // The same cache-first getters the running provider uses (~/.cache/<name>_api_key → env).
  const keys = await import('../../config.js');
  const getter: Record<string, () => string | undefined> = { openrouter: keys.getOpenRouterApiKey, openai: keys.getOpenAIApiKey,
    gemini: keys.getGeminiApiKey, opengateway: keys.getOpenGatewayApiKey };
  return getter[provider]?.();
}

/** What eln has right now: provider, secret names and local options. No key value leaves this function. */
export async function probeElnCapabilities(deps: CapabilityProbeDeps = {}): Promise<CapabilityProbe> {
  const env = deps.env ?? process.env;
  const endpoints = await providerEndpoints();
  let provider: CapabilityProbe['provider'];
  // A config or provider read failure only drops the provider step: secret → local → card still run.
  try {
    const config = deps.readConfig ? deps.readConfig() : (await import('../../user-config.js')).getUserConfig();
    let name: string = config.llm.provider;
    let model = config.llm.model;
    if (!name || name === 'auto') {
      const resolved = deps.resolveProviderName ? await deps.resolveProviderName(config) : await (async () => {
        const llm = await import('../../llm.js');
        const chosen = await llm.getProviderForConfigAsync(config, config.llm.model);
        return { name: chosen.name, defaultModel: chosen.defaultModel };
      })();
      name = resolved.name;
      model ||= resolved.defaultModel;
    }
    const rotationUrl = config.llm.rotation?.find(entry => entry.provider === name && entry.baseUrl?.trim())?.baseUrl?.trim();
    const baseUrl = name === 'local' ? env.LOCAL_LLM_URL?.trim() || rotationUrl : rotationUrl || endpoints[name];
    const subscription = name === 'openai-codex' || name === 'hq-proxy';
    const keyless = name === 'local';
    const injectable = !!baseUrl && !subscription && name !== 'bedrock' && name !== 'anthropic';
    const hasKey = injectable ? keyless || await (deps.providerHasKey ?? defaultProviderHasKey)(name, config) : false;
    provider = { name, model: wireModel(name, model ?? ''), ...(baseUrl ? { baseUrl } : {}), hasKey, injectable: injectable && !!model,
      ...(subscription ? { subscription: true } : {}), ...(keyless ? { keyless: true } : {}) };
  } catch { provider = undefined; }

  let secretNames: string[] = [];
  try {
    secretNames = deps.listSecretNames ? await deps.listSecretNames()
      : await (await import('../../nexus/config/secrets/index.js')).listSecretIdsAsync();
  } catch { secretNames = []; }
  const { OPENROUTER_MODEL, OPENAI_MODEL, GEMINI_MODEL } = await import('../../config.js');
  const llmSecretTable: Array<{ name: string; baseUrl: string; model: string }> = [
    { name: 'cred:openrouter.api_key', baseUrl: endpoints.openrouter!, model: wireModel('openrouter', OPENROUTER_MODEL) },
    { name: 'OPENROUTER_API_KEY', baseUrl: endpoints.openrouter!, model: wireModel('openrouter', OPENROUTER_MODEL) },
    { name: 'ZAI_API_KEY', baseUrl: endpoints.glm!, model: 'glm-5.3' },
    { name: 'OPENAI_API_KEY', baseUrl: endpoints.openai!, model: OPENAI_MODEL },
    { name: 'GEMINI_API_KEY', baseUrl: endpoints.gemini!, model: GEMINI_MODEL },
  ];
  const which = deps.which ?? ((tool: string) => Bun.which(tool));
  return {
    ...(provider ? { provider } : {}),
    llmSecrets: llmSecretTable.filter(entry => secretNames.includes(entry.name)),
    secretNames,
    local: {
      ...(env.LOCAL_LLM_URL?.trim() ? { llmUrl: env.LOCAL_LLM_URL.trim() } : {}),
      ...(env.LOCAL_LLM_MODEL?.trim() ? { llmModel: env.LOCAL_LLM_MODEL.trim() } : {}),
      tools: ['tesseract', 'say'].filter(tool => !!which(tool)),
    },
  };
}

export interface CapabilityEnvDeps {
  readConfig?: () => import('../../user-config/types.js').UserConfig;
  providerApiKey?: (provider: string) => Promise<string | undefined>;
  getSecret?: (name: string) => Promise<string | undefined>;
}

async function readKey(ref: CapabilityKeyRef, deps: CapabilityEnvDeps): Promise<string | undefined> {
  if (ref.kind === 'none') return undefined;
  if (ref.kind === 'secret') {
    return deps.getSecret ? deps.getSecret(ref.name)
      : (await import('../../nexus/config/secrets/index.js')).getSecretAsync(ref.name);
  }
  if (deps.providerApiKey) return deps.providerApiKey(ref.provider);
  const config = deps.readConfig ? deps.readConfig() : (await import('../../user-config.js')).getUserConfig();
  return providerApiKey(ref.provider, config);
}

export interface CapabilityRunEnv {
  env: Record<string, string>;
  /** Capabilities whose key could not be read at run time: only they run in mock mode (ELN_MOCK_<CAPABILITY>). */
  missing: string[];
}

/** The env a generated app starts with. Key values go only into this object, which goes only to spawn. */
export async function capabilityRunEnv(resolutions: readonly Pick<CapabilityResolution, 'capability' | 'env' | 'key' | 'keyEnv'>[],
  deps: CapabilityEnvDeps = {}): Promise<CapabilityRunEnv> {
  const env: Record<string, string> = {};
  const missing: string[] = [];
  for (const resolution of resolutions) {
    Object.assign(env, resolution.env);
    if (resolution.key.kind === 'none' || !resolution.keyEnv) continue;
    let value: string | undefined;
    try { value = (await readKey(resolution.key, deps))?.trim(); } catch { value = undefined; }
    if (value) env[resolution.keyEnv] = value;
    else {
      // Mock only this capability; a connected capability sharing the adapter keeps its live model.
      missing.push(resolution.capability);
      env[mockEnvName(resolution.capability)] = '1';
    }
  }
  return { env, missing };
}
