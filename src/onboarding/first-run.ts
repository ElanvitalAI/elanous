import * as readline from 'node:readline/promises';
import { detectProviders, type DetectedProvider } from '../llm/provider-detect.js';
import { debug } from '../debug/log.js';
import { resolveProviderCredential } from '../llm/provider-credentials.js';
import {
  getUserConfig, saveUserConfig, userConfigPath,
  type LLMProviderName, type UserConfig,
} from '../user-config.js';

export interface FirstRunDeps {
  config?: UserConfig;
  path?: string;
  detectProviders?: () => Promise<DetectedProvider[]>;
  isTTY?: boolean;
  chooseProvider?: () => Promise<LLMProviderName | null>;
  print?: (message: string) => void;
  saveConfig?: (config: UserConfig, path: string) => void;
}

async function chooseProvider(): Promise<LLMProviderName | null> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question('Choose LLM (1 Codex, 2 Grok, 3 Claude; Enter to cancel): ')).trim();
    return ({ '1': 'openai-codex', '2': 'grok', '3': 'anthropic' } as Record<string, LLMProviderName>)[answer] ?? null;
  } finally {
    rl.close();
  }
}

export async function runFirstRun(deps: FirstRunDeps = {}): Promise<{
  outcome: 'ready' | 'needs-llm' | 'cancelled'; provider?: string; inputs: number;
}> {
  const path = deps.path ?? userConfigPath();
  const cfg = deps.config ?? getUserConfig(path);
  const print = deps.print ?? console.log;
  let detected: DetectedProvider[] = [];
  try { detected = await (deps.detectProviders ?? detectProviders)(); }
  catch { /* Detection is advisory; a TTY can still choose. */ }
  const subscriptions = detected.filter((d) => d.available && (d.auth === 'oauth' || d.auth === 'agent-cli'));
  const providers = subscriptions.map((d) => d.provider);
  const observe = (event: 'detected' | 'chosen' | 'ready' | 'needs-llm', inputs: number) =>
    debug.log('onboarding.first-run', event, { providers, inputs });
  observe('detected', 0);
  // An incomplete onboarding marker does not mean the user's LLM is unconfigured.
  // Keep an already usable provider, key and model rather than replacing them with a detected subscription.
  const existing = cfg.llm.provider !== 'auto'
    ? resolveProviderCredential({ provider: cfg.llm.provider, rotation: cfg.llm.rotation,
        baseProvider: cfg.llm.provider, baseApiKey: cfg.llm.apiKey })
    : undefined;
  const configured = existing && existing.source !== 'none'
    ? cfg.llm.provider : undefined;
  const picked = (['openai-codex', 'grok', 'claude-code', 'anthropic', 'gemini', 'openai', 'openrouter'] as const)
    .find((name) => providers.includes(name));
  let provider: LLMProviderName | null | undefined = configured ??
    (picked === 'claude-code' ? 'anthropic' : picked as LLMProviderName | undefined);
  let inputs = 0;
  if (!provider) {
    if ((deps.isTTY ?? process.stdin.isTTY) !== true) {
      print('eln setup llm 으로 고르세요');
      observe('needs-llm', 0);
      return { outcome: 'needs-llm', inputs: 0 };
    }
    inputs = 1;
    provider = await (deps.chooseProvider ?? chooseProvider)();
    if (!provider) return { outcome: 'cancelled', inputs };
    observe('chosen', inputs);
  }
  const credential = inputs === 1 || provider !== cfg.llm.provider
    ? resolveProviderCredential({
        provider, rotation: cfg.llm.rotation,
        baseProvider: cfg.llm.provider, baseApiKey: cfg.llm.apiKey,
      })
    : undefined;
  if (inputs === 1 && credential?.source === 'none') {
    print('eln setup llm 으로 고르세요');
    observe('needs-llm', inputs);
    return { outcome: 'needs-llm', inputs };
  }
  (deps.saveConfig ?? saveUserConfig)({
    ...cfg,
    llm: { ...cfg.llm, provider,
      ...(provider !== cfg.llm.provider ? { apiKey: credential?.apiKey, baseUrl: credential?.baseUrl, model: undefined } : {}),
      ...(credential?.apiKey ? { apiKey: credential.apiKey } : {}),
      ...(credential?.baseUrl ? { baseUrl: credential.baseUrl } : {}) },
    onboarding: { ...cfg.onboarding, ready: true },
  }, path);
  observe('ready', inputs);
  return { outcome: 'ready', provider, inputs };
}
