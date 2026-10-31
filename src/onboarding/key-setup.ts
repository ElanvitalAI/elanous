import { getProviderForConfig, type LLMProvider } from '../llm.js';
import { providerEnvKey, resolveProviderCredential } from '../llm/provider-credentials.js';
import { probeProvider } from '../llm/provider-probe.js';
import type { UserConfig } from '../user-config.js';
import { getSecretAsync, setSecretAsync } from '../nexus/config/secrets/index.js';

export const KEY_SETUP_SERVICES = [
  { provider: 'anthropic', label: 'Anthropic' },
  { provider: 'grok', label: 'Grok' },
  { provider: 'gemini', label: 'Gemini' },
  { provider: 'openrouter', label: 'OpenRouter' },
  { provider: 'opengateway', label: 'OpenGateway' },
  { provider: 'openai', label: 'OpenAI' },
] as const;

type KeySetupService = (typeof KEY_SETUP_SERVICES)[number];
type KeyStatus = 'success' | 'failed' | 'skipped';

export interface KeySetupResult {
  provider: string;
  label: string;
  status: KeyStatus;
}

export interface KeySetupDeps {
  config: UserConfig;
  promptSecret: (message: string) => Promise<string | undefined>;
  print: (message: string) => void;
  getSecret?: (id: string) => Promise<string | undefined>;
  setSecret?: (id: string, value: string) => Promise<void>;
  probe?: (provider: LLMProvider) => Promise<{ success: boolean }>;
  providers?: readonly string[];
}

function importedKeys(value: string | undefined): Map<string, string> {
  const keys = new Map<string, string>();
  for (const line of value?.split(/\r?\n/) ?? []) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    const raw = match[2] ?? '';
    const unquoted = (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))
      ? raw.slice(1, -1) : raw;
    if (unquoted) keys.set(match[1]!, unquoted);
  }
  return keys;
}

function serviceKey(service: KeySetupService): string | undefined {
  return providerEnvKey(service.provider);
}

function serviceSelected(service: KeySetupService, providers: readonly string[] | undefined): boolean {
  return providers === undefined || providers.includes(service.provider);
}

/** Collect API keys without rendering values, then probe each newly supplied key once. */
export async function collectServiceKeys(deps: KeySetupDeps): Promise<KeySetupResult[]> {
  const getSecret = deps.getSecret ?? getSecretAsync;
  const setSecret = deps.setSecret ?? setSecretAsync;
  const probe = deps.probe ?? probeProvider;
  const pasted = importedKeys(await deps.promptSecret('.env 형식 키를 붙여 넣고 빈 줄로 끝내세요 (건너뛰려면 Enter): '));
  const results: KeySetupResult[] = [];
  for (const service of KEY_SETUP_SERVICES) {
    if (!serviceSelected(service, deps.providers)) continue;
    const id = serviceKey(service);
    if (!id) continue;
    const existing = await getSecret(id);
    const configured = resolveProviderCredential({
      provider: service.provider,
      rotation: deps.config.llm.rotation,
      baseProvider: deps.config.llm.provider,
      baseApiKey: deps.config.llm.apiKey,
    }).source !== 'none';
    if (existing || configured) {
      results.push({ ...service, status: 'skipped' });
      continue;
    }
    const value = pasted.get(id) ?? (await deps.promptSecret(`${service.label} 키 (${id}, 건너뛰려면 Enter): `))?.trim();
    if (!value) {
      results.push({ ...service, status: 'skipped' });
      continue;
    }
    await setSecret(id, value);
    let success = false;
    try {
      const provider = getProviderForConfig({
        ...deps.config,
        llm: { ...deps.config.llm, provider: service.provider as UserConfig['llm']['provider'], apiKey: value, model: undefined },
      });
      success = (await probe(provider)).success;
    } catch { /* The status table deliberately keeps provider failures value-free. */ }
    results.push({ ...service, status: success ? 'success' : 'failed' });
  }
  return results;
}

export function printKeySetupReport(results: readonly KeySetupResult[], print: (message: string) => void): void {
  print('키 설정 결과');
  for (const result of results) {
    print(`${result.status === 'success' ? '✅' : result.status === 'failed' ? '❌' : '건너뜀'} ${result.label}`);
  }
  print('Telegram 봇 설정: https://t.me/BotFather');
}
