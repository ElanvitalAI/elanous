// APP-BUILD-CAPABILITY-RESOLUTION — an app that needs an external capability (translation, summarization,
// OCR, TTS, search) resolves it from what the user already has before a person is asked:
//   (1) the LLM provider eln itself runs on (same provider/model/key, injected server-side as env),
//   (2) a key already in the eln secret store (injected by name at run),
//   (3) a free or local option,
//   (4) only then a numbered choice card with a recommendation — never a dead end: the app is still built
//       in mock mode and the card says how to connect the real engine.
// Translation defaults to LLM translation (CEO 11-26: «그냥 LLM 의 트랜슬레이션을 써도 되지 않나요?»).
//
// Pure: the probe (what eln has) is an input and carries names only — never a key value.

export const APP_CAPABILITIES = ['translation', 'summarization', 'ocr', 'tts', 'search'] as const;
export type AppCapability = typeof APP_CAPABILITIES[number];

/** What eln already has. Names and endpoints only; the key value is read at run time by the launcher. */
export interface CapabilityProbe {
  /** The provider the current eln session runs on. */
  provider?: {
    name: string;
    model: string;
    /** OpenAI-compatible root (…/v1) when the provider can be called by a plain HTTP adapter. */
    baseUrl?: string;
    /** A credential for this provider resolves on this host (or the provider is keyless). */
    hasKey: boolean;
    /** False for providers a plain OpenAI-compatible adapter cannot call (subscription/OAuth, native-only APIs). */
    injectable: boolean;
    /** Subscription/OAuth provider (openai-codex): there is no API key to inject at all. */
    subscription?: boolean;
    /** Keyless provider (local): the app calls it without any key. */
    keyless?: boolean;
  };
  /** LLM keys present in the eln secret store, in preference order, with the endpoint each one belongs to. */
  llmSecrets: Array<{ name: string; baseUrl: string; model: string }>;
  /** Other secret names present in the eln secret store (service keys such as TAVILY_API_KEY). */
  secretNames: string[];
  /** Local options on this machine. */
  local: { llmUrl?: string; llmModel?: string; tools: string[] };
}

export type CapabilityKeyRef =
  | { kind: 'provider'; provider: string }
  | { kind: 'secret'; name: string }
  | { kind: 'none' };

export interface CapabilityChoiceOption {
  n: number;
  id: string;
  label: string;
  /** What the person does for this option (a command or a value to give). */
  action: string;
  recommended: boolean;
}

export interface CapabilityChoiceCard {
  capability: AppCapability;
  question: string;
  options: CapabilityChoiceOption[];
  recommended: number;
}

export interface CapabilityResolution {
  capability: AppCapability;
  status: 'resolved' | 'needs-choice';
  source: 'eln-provider' | 'eln-secret' | 'local' | 'free' | 'mock';
  engine: 'llm' | 'service' | 'local-tool' | 'free-api' | 'mock';
  /** Non-secret env the launcher sets as-is. */
  env: Record<string, string>;
  /** Where the launcher reads the key at run time; the value never enters code, files or chat. */
  key: CapabilityKeyRef;
  /** Env name the app reads the key from (ELN_LLM_API_KEY for the LLM adapter; the service name otherwise). */
  keyEnv?: string;
  summary: string;
  card?: CapabilityChoiceCard;
}

/** Per-capability mock flag: mocks only this capability, never another connected one (ELN_MOCK_TRANSLATION …). */
export function mockEnvName(capability: AppCapability): string {
  return `ELN_MOCK_${capability.toUpperCase()}`;
}

const LLM_CAPABLE: ReadonlySet<AppCapability> = new Set(['translation', 'summarization', 'ocr']);

const LABEL: Record<AppCapability, string> = {
  translation: '번역', summarization: '요약', ocr: '문자 인식(OCR)', tts: '음성 합성(TTS)', search: '검색',
};

/** Service keys that serve a capability directly, in preference order. */
const SERVICE_SECRETS: Record<AppCapability, string[]> = {
  translation: ['DEEPL_API_KEY'],
  summarization: [],
  ocr: ['UPSTAGE_API_KEY'],
  tts: ['ELEVENLABS_API_KEY', 'OPENAI_API_KEY'],
  search: ['TAVILY_API_KEY', 'FIRECRAWL_API_KEY'],
};

/** Free or local fallbacks that need no key. */
const FREE: Record<AppCapability, { tool?: string; id: string; label: string; engine: 'local-tool' | 'free-api' } | undefined> = {
  translation: undefined,
  summarization: undefined,
  ocr: { tool: 'tesseract', id: 'tesseract', label: '로컬 tesseract', engine: 'local-tool' },
  tts: { tool: 'say', id: 'macos-say', label: '로컬 macOS say', engine: 'local-tool' },
  search: { id: 'duckduckgo-html', label: 'DuckDuckGo (무료 · 키 없음)', engine: 'free-api' },
};

// Lexical cues are the fallback only: the app_build caller declares `capabilities` structurally first.
const CUES: Record<AppCapability, RegExp> = {
  translation: /(번역|통역|\b(?:translat\w*|interpret(?:er|ation)|localiz\w*)\b)/iu,
  summarization: /(요약|\b(?:summar\w*|tl;?dr)\b)/iu,
  ocr: /(OCR|문자 ?인식|글자 ?인식|이미지.{0,6}텍스트|\b(?:text recognition|scan(?:ned)? text)\b)/iu,
  tts: /(TTS|음성 ?합성|읽어 ?주|소리로 ?읽|\b(?:text[- ]to[- ]speech|speech synthesis|read aloud)\b)/iu,
  search: /(웹 ?검색|검색 ?엔진|\b(?:web search|search engine)\b)/iu,
};

function isCapability(value: unknown): value is AppCapability {
  return typeof value === 'string' && (APP_CAPABILITIES as readonly string[]).includes(value);
}

/** Capabilities the app needs: the caller's structured declaration wins; the line's cues fill in otherwise. */
export function detectCapabilityNeeds(line: string, declared?: unknown): AppCapability[] {
  if (Array.isArray(declared)) {
    const picked = declared.map(item => typeof item === 'string' ? item.trim().toLowerCase() : item).filter(isCapability);
    if (picked.length) return [...new Set(picked)];
  }
  return APP_CAPABILITIES.filter(capability => CUES[capability].test(line));
}

function llmEnv(baseUrl: string, model: string): Record<string, string> {
  return { ELN_LLM_BASE_URL: baseUrl.replace(/\/+$/u, ''), ELN_LLM_MODEL: model };
}

function llmCard(capability: AppCapability, probe: CapabilityProbe): CapabilityChoiceCard {
  const label = LABEL[capability];
  const provider = probe.provider;
  const why = provider && !provider.injectable
    ? provider.subscription ? `지금 eln 공급자(${provider.name})는 구독 인증이라 앱에 넣을 수 없습니다. `
      : `지금 eln 공급자(${provider.name})는 앱의 OpenAI 호환 어댑터로 부를 수 없습니다. `
    : provider && !provider.hasKey ? `지금 eln 공급자(${provider.name})의 키를 이 기기에서 찾지 못했습니다. ` : '';
  const options: CapabilityChoiceOption[] = [
    { n: 1, id: 'llm-openrouter', label: `LLM ${label} 사용 (OpenRouter 키 연결)`, action: 'eln secret set OPENROUTER_API_KEY', recommended: true },
    { n: 2, id: 'llm-local', label: `로컬 LLM ${label} 사용 (ollama 등)`, action: 'LOCAL_LLM_URL=http://localhost:11434/v1 지정 후 다시 실행', recommended: false },
  ];
  if (capability === 'translation') {
    options.push({ n: 3, id: 'libretranslate', label: 'LibreTranslate 주소·키 입력', action: 'eln secret set LIBRETRANSLATE_API_KEY 와 주소 알려 주기', recommended: false });
  } else if (capability === 'ocr') {
    options.push({ n: 3, id: 'upstage', label: 'Upstage Document Parse 키 연결', action: 'eln secret set UPSTAGE_API_KEY', recommended: false });
  }
  options.push({ n: options.length + 1, id: 'mock', label: '모의 응답으로 먼저 완성, 키는 나중에 연결', action: '그대로 두기 — 앱은 [mock] 결과로 동작', recommended: false });
  return { capability, question: `${why}${label} 엔진을 고르세요. 앱은 지금 모의 응답으로 이미 동작합니다.`, options, recommended: 1 };
}

function serviceCard(capability: AppCapability): CapabilityChoiceCard {
  const options: CapabilityChoiceOption[] = SERVICE_SECRETS[capability].map((name, index) => ({
    n: index + 1, id: name.toLowerCase(), label: `${name} 연결`, action: `eln secret set ${name}`, recommended: index === 0,
  }));
  options.push({ n: options.length + 1, id: 'mock', label: '모의 응답으로 먼저 완성, 키는 나중에 연결', action: '그대로 두기', recommended: options.length === 0 });
  return { capability, question: `${LABEL[capability]} 엔진을 고르세요. 앱은 지금 모의 응답으로 이미 동작합니다.`, options,
    recommended: options.find(option => option.recommended)!.n };
}

/** Resolve one capability in the fixed order: eln provider → eln secret → free/local → choice card. */
export function resolveCapability(capability: AppCapability, probe: CapabilityProbe): CapabilityResolution {
  const label = LABEL[capability];
  if (LLM_CAPABLE.has(capability)) {
    const provider = probe.provider;
    if (provider?.injectable && provider.hasKey && provider.baseUrl) {
      return { capability, status: 'resolved', source: 'eln-provider', engine: 'llm',
        env: llmEnv(provider.baseUrl, provider.model),
        ...(provider.keyless ? { key: { kind: 'none' as const } } : { key: { kind: 'provider' as const, provider: provider.name }, keyEnv: 'ELN_LLM_API_KEY' }),
        summary: provider.keyless ? `${label} = LLM (지금 eln 공급자 ${provider.name} · ${provider.model} · 키 없음)`
          : `${label} = LLM (지금 eln 공급자 ${provider.name} · ${provider.model} · 키는 실행 때 env 로 주입)` };
    }
    const stored = probe.llmSecrets[0];
    if (stored) {
      return { capability, status: 'resolved', source: 'eln-secret', engine: 'llm',
        env: llmEnv(stored.baseUrl, stored.model), key: { kind: 'secret', name: stored.name }, keyEnv: 'ELN_LLM_API_KEY',
        summary: `${label} = LLM (eln secret ${stored.name} · ${stored.model} · 이름으로 실행 때 주입)` };
    }
    if (probe.local.llmUrl) {
      const model = probe.local.llmModel || 'llama3';
      return { capability, status: 'resolved', source: 'local', engine: 'llm',
        env: llmEnv(probe.local.llmUrl, model), key: { kind: 'none' },
        summary: `${label} = 로컬 LLM (${probe.local.llmUrl} · ${model} · 키 없음)` };
    }
  }
  const service = SERVICE_SECRETS[capability].find(name => probe.secretNames.includes(name));
  if (service) {
    return { capability, status: 'resolved', source: 'eln-secret', engine: 'service', env: {},
      key: { kind: 'secret', name: service }, keyEnv: service,
      summary: `${label} = ${service} (eln secret · 이름으로 실행 때 주입)` };
  }
  const free = FREE[capability];
  if (free && (!free.tool || probe.local.tools.includes(free.tool))) {
    return { capability, status: 'resolved', source: free.engine === 'local-tool' ? 'local' : 'free', engine: free.engine,
      env: { ELN_CAPABILITY_ENGINE: free.id }, key: { kind: 'none' }, summary: `${label} = ${free.label}` };
  }
  const card = LLM_CAPABLE.has(capability) ? llmCard(capability, probe) : serviceCard(capability);
  return { capability, status: 'needs-choice', source: 'mock', engine: 'mock', env: { [mockEnvName(capability)]: '1' }, key: { kind: 'none' },
    summary: `${label} = 모의 응답(엔진 미연결 · 선택 카드 ${card.options.length}안 · 추천 ${card.recommended})`, card };
}

export function resolveCapabilities(capabilities: readonly AppCapability[], probe: CapabilityProbe): CapabilityResolution[] {
  return capabilities.map(capability => resolveCapability(capability, probe));
}

/** The numbered card as text («1) … (추천)»). */
export function renderChoiceCard(card: CapabilityChoiceCard): string {
  return [card.question, ...card.options.map(option =>
    `${option.n}) ${option.label}${option.recommended ? ' · 추천' : ''} — ${option.action}`)].join('\n');
}
