import * as readline from 'node:readline/promises';
import { detectProviders, type DetectedProvider } from '../llm/provider-detect.js';
import { debug } from '../debug/log.js';
import { detectLocale, type Locale } from '../expression/locale.js';
import { unattendedNextStepLine } from './entry-hints.js';
import { resolveProviderCredential } from '../llm/provider-credentials.js';
import { zaiCodingPlanAvailable } from '../llm/zai-coding-plan.js';
import { collectServiceKeys, printKeySetupReport } from './key-setup.js';
import { getSecretAsync, setSecretAsync } from '../nexus/config/secrets/index.js';
import { probeProvider } from '../llm/provider-probe.js';
import { createSecretPrompt } from './secret-prompt.js';
import { parseMenuAnswer as parseNumericMenuAnswer } from './menu-answer.js';
import {
  getUserConfig, saveUserConfig, userConfigPath,
  type LLMProviderName, type UserConfig,
} from '../user-config.js';

export interface FirstRunDeps {
  config?: UserConfig;
  env?: NodeJS.ProcessEnv;
  path?: string;
  detectProviders?: () => Promise<DetectedProvider[]>;
  isTTY?: boolean;
  /** Locale for user-facing wording; defaults to the shared ambient decision (detectLocale). */
  locale?: Locale;
  chooseProvider?: (detected: readonly LLMProviderName[]) => Promise<LLMProviderName | null>;
  promptSecret?: (message: string) => Promise<string | undefined>;
  getSecretAsync?: typeof getSecretAsync;
  setSecretAsync?: typeof setSecretAsync;
  probeKey?: typeof probeProvider;
  setupWhenNoProvider?: (config: UserConfig) => Promise<FirstRunProviderSetupResult>;
  print?: (message: string) => void;
  saveConfig?: (config: UserConfig, path: string) => void;
}

export type FirstRunProviderSetupResult = LLMProviderName | null | { kind: 'needs-llm' };

const CHOICE_BASE: readonly LLMProviderName[] = ['openai-codex', 'grok', 'anthropic', 'openrouter', 'glm'];
const CHOICE_LABEL: Partial<Record<LLMProviderName, string>> = { 'openai-codex': 'Codex', grok: 'Grok', anthropic: 'Claude', openrouter: 'OpenRouter', glm: 'GLM' };
const SUBSCRIPTION_PRIORITY = ['openai-codex', 'grok', 'anthropic', 'gemini', 'openai', 'glm', 'openrouter'] as const;

/** Menu order: detected usable providers first, then the remaining supported choices. */
export function orderProviderChoices(detected: readonly LLMProviderName[] = []): LLMProviderName[] {
  return [...detected, ...CHOICE_BASE.filter((name) => !detected.includes(name))];
}

export type MenuAnswer = import('./menu-answer.js').MenuAnswer<LLMProviderName>;

// FIRST10-FIX: 첫 화면의 오타 한 번이 first-run 전체를 취소하던 마찰 — 빈 입력(취소 의사)과 달리
// 선택지를 가리키지 못하는 입력(범위 밖·전각·비정수)은 취소가 아니라 다시 묻는다.
// 메뉴 답으로 인정하는 건 반각 십진 자릿수 문자열뿐이다 — Number() 는 '1e0'·'0x1'·'+1' 같은
// 수식 표기를 정수로 강제 변환해 선택지로 샌다(0.2.35 재측정).
export function parseMenuAnswer(answer: string, choices: readonly LLMProviderName[]): MenuAnswer {
  return parseNumericMenuAnswer(answer, choices);
}

/**
 * The choice line of the first-run menu.
 * Single source of the wording: the prompt below renders it, and the ux-sim
 * first-run device asserts against it, so a wording change cannot drift apart.
 */
export function formatProviderMenu(choices: readonly LLMProviderName[]): string {
  return choices.map((name, i) => `${i + 1} ${CHOICE_LABEL[name] ?? name}`).join(', ');
}

export const FIRST_RUN_PROVIDER_MENU_PROMPT = 'Choose LLM';

export async function promptProviderMenu(
  ask: (prompt: string) => Promise<string>,
  detected: readonly LLMProviderName[] = [],
): Promise<LLMProviderName | null> {
  const choices = orderProviderChoices(detected);
  const menu = formatProviderMenu(choices);
  for (;;) {
    const parsed = parseMenuAnswer(await ask(`${FIRST_RUN_PROVIDER_MENU_PROMPT} (${menu}; Enter to cancel): `), choices);
    if (parsed.kind === 'chosen') return parsed.provider;
    if (parsed.kind === 'cancel') return null;
  }
}

async function chooseProvider(detected: readonly LLMProviderName[] = []): Promise<LLMProviderName | null> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await promptProviderMenu((prompt) => rl.question(prompt), detected);
  } finally {
    rl.close();
  }
}

/** User-facing first-run fallback wording, routed by the shared locale decision (detectLocale). */
const FIRST_RUN_TEXT = {
  ko: {
    detectedPrefix: '감지: ',
    subscription: ' 구독',
    needsLlm: 'eln setup llm 으로 고르세요',
    keyStoredNotReady: '키를 저장하고 검증했지만 첫 실행에서 사용할 provider 연결은 아직 완료되지 않았습니다.',
    keySetupFailed: '키 설정을 완료하지 못했습니다. 비밀 값을 표시하지 않고 중단했습니다.',
    claudeNoPath: 'claude-code 구독은 구독으로 쓸 수 있는 경로가 없어 자동 선택하지 않음',
    multipleDetected: '둘 이상 감지되어 고르세요',
  },
  en: {
    detectedPrefix: 'detected: ',
    subscription: ' subscription',
    needsLlm: 'pick a provider via eln setup llm',
    keyStoredNotReady: 'The key was saved and verified, but first-run provider setup is not complete yet.',
    keySetupFailed: 'Key setup could not be completed. It stopped without displaying secret values.',
    claudeNoPath: 'claude-code subscription has no usable path in elanous; not auto-selecting',
    multipleDetected: 'more than one detected; pick one',
  },
} as const;

export async function runFirstRun(deps: FirstRunDeps = {}): Promise<{
  outcome: 'ready' | 'needs-llm' | 'cancelled'; provider?: string; inputs: number;
}> {
  const path = deps.path ?? userConfigPath();
  const cfg = deps.config ?? getUserConfig(path);
  const print = deps.print ?? console.log;
  const text = FIRST_RUN_TEXT[(deps.locale ?? detectLocale()) === 'en' ? 'en' : 'ko'];
  const detectionLabel = (provider: string) =>
    `${provider === 'openai-codex' ? 'codex' : provider}${text.subscription}`;
  // An incomplete onboarding marker does not mean the user's LLM is unconfigured.
  // Keep an already usable provider, key and model rather than replacing it with a detected subscription.
  const existing = cfg.llm.provider !== 'auto'
    ? resolveProviderCredential({ provider: cfg.llm.provider, rotation: cfg.llm.rotation,
        baseProvider: cfg.llm.provider, baseApiKey: cfg.llm.apiKey, env: deps.env })
    : undefined;
  const configured = existing && existing.source !== 'none'
    ? cfg.llm.provider
    // Z.ai's coding-plan credential is stored in its dedicated cache/env, not llm.apiKey.
    : cfg.llm.provider === 'glm' && zaiCodingPlanAvailable() ? 'glm' : undefined;
  let detected: DetectedProvider[] = [];
  // This read-only scan is unconditional, even with an incomplete existing config;
  // provider availability must not depend on the setup marker/config being absent.
  try { detected = await (deps.detectProviders ?? detectProviders)(); }
  catch { /* Detection is advisory; a TTY can still choose. */ }
  const subscriptions = detected.filter((d) => d.available && (d.auth === 'oauth' || d.auth === 'agent-cli'));
  const providers = subscriptions.map((d) => d.provider);
  const observe = (event: 'detected' | 'chosen' | 'ready' | 'needs-llm', inputs: number) =>
    debug.log('onboarding.first-run', event, { providers, inputs });
  observe('detected', 0);
  // claude-code is detected but has no subscription path in elanous: mapping it to the 'anthropic'
  // API-key provider would save a provider whose first call fails for a subscription-only user.
  const usable = SUBSCRIPTION_PRIORITY.filter((name) => providers.includes(name));
  const detectionLine = (outcome: string) => `${text.detectedPrefix}${providers.map(detectionLabel).join(' · ')} → ${outcome}`;
  const needsLlm = (inputs: number, extra: string[] = []) => {
    print(text.needsLlm);
    for (const line of extra) print(line);
    observe('needs-llm', inputs);
    return { outcome: 'needs-llm' as const, inputs };
  };
  let provider: LLMProviderName | null | undefined = configured ?? (usable.length === 1 ? usable[0] : undefined);
  if (!configured && provider) print(detectionLine(provider));
  let inputs = 0;
  let providerSetUpInPlace = false;
  if (!provider) {
    if (providers.length > 0) {
      print(detectionLine(usable.length === 0
        ? text.claudeNoPath
        : text.multipleDetected));
    }
    if ((deps.isTTY ?? process.stdin.isTTY) !== true) {
      // FIRST-CHAT-NONTTY — bare `elanous` with no TTY gets the same one-line next step as the other entrances.
      return needsLlm(0, [unattendedNextStepLine()]);
    }
    if (deps.setupWhenNoProvider && usable.length === 0) {
      inputs = 1;
      const setupResult = await deps.setupWhenNoProvider(cfg);
      if (typeof setupResult === 'object' && setupResult !== null && setupResult.kind === 'needs-llm') {
        return needsLlm(inputs);
      }
      provider = typeof setupResult === 'string' ? setupResult : null;
      if (!provider) {
        print('LLM 없이 첫 화면을 엽니다. LLM 기능은 사용할 수 없습니다. 다시 설정: `elanous setup keys` 또는 `elanous login openai-codex`.');
        (deps.saveConfig ?? saveUserConfig)({ ...cfg, onboarding: { ...cfg.onboarding, ready: true } }, path);
        observe('ready', inputs);
        return { outcome: 'ready', inputs };
      }
      providerSetUpInPlace = true;
      observe('chosen', inputs);
    } else {
    inputs = 1;
    provider = await (deps.chooseProvider ?? chooseProvider)(usable);
    if (!provider) return { outcome: 'cancelled', inputs };
    observe('chosen', inputs);
    }
  }
  const credential = inputs === 1 || provider !== cfg.llm.provider
    ? resolveProviderCredential({
        provider, rotation: cfg.llm.rotation,
        baseProvider: cfg.llm.provider, baseApiKey: cfg.llm.apiKey,
        env: deps.env,
      })
    : undefined;
  if (inputs === 1 && credential?.source === 'none'
    && !(providerSetUpInPlace && provider === 'openai-codex')) {
    if ((deps.isTTY ?? process.stdin.isTTY) !== true) return needsLlm(inputs);
    try {
      const results = await collectServiceKeys({
        config: cfg,
        promptSecret: deps.promptSecret ?? createSecretPrompt(),
        print,
        getSecret: deps.getSecretAsync,
        setSecret: deps.setSecretAsync,
        probe: deps.probeKey,
        providers: [provider],
      });
      printKeySetupReport(results, print);
      if (results.length === 0 || results.some((result) => result.status !== 'success')) return needsLlm(inputs);
      return needsLlm(inputs, [text.keyStoredNotReady]);
    } catch {
      return needsLlm(inputs, [text.keySetupFailed]);
    }
  }
  (deps.saveConfig ?? saveUserConfig)({
    ...cfg,
    llm: { ...cfg.llm, provider,
      ...(provider !== cfg.llm.provider ? {
        apiKey: credential?.source === 'rotation' ? credential.apiKey : undefined,
        baseUrl: credential?.baseUrl,
        model: undefined,
      } : {}),
      ...(credential?.source === 'rotation' && credential.apiKey ? { apiKey: credential.apiKey } : {}),
      ...(credential?.baseUrl ? { baseUrl: credential.baseUrl } : {}) },
    onboarding: { ...cfg.onboarding, ready: true },
  }, path);
  observe('ready', inputs);
  return { outcome: 'ready', provider, inputs };
}
