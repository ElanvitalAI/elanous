import * as readline from 'node:readline/promises';
import { detectProviders, type DetectedProvider } from '../llm/provider-detect.js';
import { debug } from '../debug/log.js';
import { detectLocale, type Locale } from '../expression/locale.js';
import { unattendedNextStepLine } from './entry-hints.js';
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
  /** Locale for user-facing wording; defaults to the shared ambient decision (detectLocale). */
  locale?: Locale;
  chooseProvider?: (detected: readonly LLMProviderName[]) => Promise<LLMProviderName | null>;
  print?: (message: string) => void;
  saveConfig?: (config: UserConfig, path: string) => void;
}

const CHOICE_BASE: readonly LLMProviderName[] = ['openai-codex', 'grok', 'anthropic'];
const CHOICE_LABEL: Partial<Record<LLMProviderName, string>> = { 'openai-codex': 'Codex', grok: 'Grok', anthropic: 'Claude' };
const SUBSCRIPTION_PRIORITY = ['openai-codex', 'grok', 'anthropic', 'gemini', 'openai', 'openrouter'] as const;

/** Menu order: detected subscriptions first (in priority order), then the remaining base choices. */
export function orderProviderChoices(detected: readonly LLMProviderName[] = []): LLMProviderName[] {
  return [...detected, ...CHOICE_BASE.filter((name) => !detected.includes(name))];
}

export type MenuAnswer =
  | { kind: 'chosen'; provider: LLMProviderName }
  | { kind: 'cancel' }
  | { kind: 'miss' };

// FIRST10-FIX: 첫 화면의 오타 한 번이 first-run 전체를 취소하던 마찰 — 빈 입력(취소 의사)과 달리
// 선택지를 가리키지 못하는 입력(범위 밖·전각·비정수)은 취소가 아니라 다시 묻는다.
// 메뉴 답으로 인정하는 건 반각 십진 자릿수 문자열뿐이다 — Number() 는 '1e0'·'0x1'·'+1' 같은
// 수식 표기를 정수로 강제 변환해 선택지로 샌다(0.2.35 재측정).
export function parseMenuAnswer(answer: string, choices: readonly LLMProviderName[]): MenuAnswer {
  const trimmed = answer.trim();
  if (trimmed === '') return { kind: 'cancel' };
  if (!/^[0-9]+$/.test(trimmed)) return { kind: 'miss' };
  const provider = choices[Number(trimmed) - 1];
  return provider !== undefined ? { kind: 'chosen', provider } : { kind: 'miss' };
}

/**
 * The fixed choice line of the first-run menu (`1 Codex, 2 Grok, 3 Claude`).
 * Single source of the wording: the prompt below renders it, and the ux-sim
 * first-run device asserts against it, so a wording change cannot drift apart.
 */
export function formatProviderMenu(choices: readonly LLMProviderName[]): string {
  return choices.map((name, i) => `${i + 1} ${CHOICE_LABEL[name] ?? name}`).join(', ');
}

export async function promptProviderMenu(
  ask: (prompt: string) => Promise<string>,
  detected: readonly LLMProviderName[] = [],
): Promise<LLMProviderName | null> {
  const choices = orderProviderChoices(detected);
  const menu = formatProviderMenu(choices);
  for (;;) {
    const parsed = parseMenuAnswer(await ask(`Choose LLM (${menu}; Enter to cancel): `), choices);
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
    claudeNoPath: 'claude-code 구독은 구독으로 쓸 수 있는 경로가 없어 자동 선택하지 않음',
    multipleDetected: '둘 이상 감지되어 고르세요',
  },
  en: {
    detectedPrefix: 'detected: ',
    subscription: ' subscription',
    needsLlm: 'pick a provider via eln setup llm',
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
    inputs = 1;
    provider = await (deps.chooseProvider ?? chooseProvider)(usable);
    if (!provider) return { outcome: 'cancelled', inputs };
    observe('chosen', inputs);
  }
  const credential = inputs === 1 || provider !== cfg.llm.provider
    ? resolveProviderCredential({
        provider, rotation: cfg.llm.rotation,
        baseProvider: cfg.llm.provider, baseApiKey: cfg.llm.apiKey,
      })
    : undefined;
  if (inputs === 1 && credential?.source === 'none') return needsLlm(inputs);
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
