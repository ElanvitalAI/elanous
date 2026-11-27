// eln-llm — server-side LLM adapter that eln copies into a generated app as backend/eln-llm.ts.
//
// The app never holds a key in code, config or the browser. eln resolves the capability when it builds the
// app (current eln provider → eln secret → local LLM) and injects only these env values when it starts the
// process: ELN_LLM_BASE_URL (OpenAI-compatible root, e.g. https://openrouter.ai/api/v1), ELN_LLM_MODEL,
// ELN_LLM_API_KEY (absent for a keyless local model). ELN_LLM_MOCK=1 answers deterministically without a
// network call — tests use it. ELN_MOCK_<CAPABILITY>=1 (e.g. ELN_MOCK_TRANSLATION) mocks one capability only: eln sets
// it when that capability has no engine yet, so another capability that is connected keeps calling the real model.
//
// This file is self-contained on purpose: it ships inside the generated app and imports nothing from eln.

export interface ElnLlmEnv {
  ELN_LLM_BASE_URL?: string;
  ELN_LLM_MODEL?: string;
  ELN_LLM_API_KEY?: string;
  ELN_LLM_MOCK?: string;
  ELN_MOCK_TRANSLATION?: string;
  ELN_MOCK_SUMMARIZATION?: string;
}

export type ElnCapability = 'translation' | 'summarization';

export class ElnLlmUnavailableError extends Error {
  readonly status = 503;
  constructor(message: string) { super(message); this.name = 'ElnLlmUnavailableError'; }
}

export interface ElnLlmOptions {
  env?: ElnLlmEnv;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
  /** Request ceiling in milliseconds (default 60s). */
  timeoutMs?: number;
}

export function elnLlmMode(env: ElnLlmEnv = process.env as ElnLlmEnv): 'mock' | 'live' | 'unconfigured' {
  if (env.ELN_LLM_MOCK === '1') return 'mock';
  return env.ELN_LLM_BASE_URL?.trim() && env.ELN_LLM_MODEL?.trim() ? 'live' : 'unconfigured';
}

/** The mode one capability runs in: a per-capability mock flag only affects that capability. */
export function elnCapabilityMode(capability: ElnCapability, env: ElnLlmEnv = process.env as ElnLlmEnv): 'mock' | 'live' | 'unconfigured' {
  const flag = capability === 'translation' ? env.ELN_MOCK_TRANSLATION : env.ELN_MOCK_SUMMARIZATION;
  return flag === '1' ? 'mock' : elnLlmMode(env);
}

/** One chat completion. The key is read from env at call time and only sent in the Authorization header. */
export async function elnComplete(system: string, user: string, options: ElnLlmOptions = {}): Promise<string> {
  const env = options.env ?? process.env as ElnLlmEnv;
  const mode = elnLlmMode(env);
  if (mode === 'mock') return `[mock] ${user}`;
  if (mode === 'unconfigured') {
    throw new ElnLlmUnavailableError('LLM capability is not connected: start this app with `eln app run-local <dir>` so eln injects it');
  }
  const base = env.ELN_LLM_BASE_URL!.trim().replace(/\/+$/u, '');
  const key = env.ELN_LLM_API_KEY?.trim();
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 60_000);
  const response = await (options.fetcher ?? fetch)(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ model: env.ELN_LLM_MODEL!.trim(), temperature: 0,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
    signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    // The provider body can echo request details; only the status leaves this function.
    throw new ElnLlmUnavailableError(`LLM provider answered HTTP ${response.status}`);
  }
  const body = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new ElnLlmUnavailableError('LLM provider returned no text');
  return content.trim();
}

/** Translate text into `target` (a language name or code). Mock output is `[mock:<source>→<target>] text`. */
export async function elnTranslate(text: string, target: string, source = 'auto', options: ElnLlmOptions = {}): Promise<string> {
  const env = options.env ?? process.env as ElnLlmEnv;
  if (elnCapabilityMode('translation', env) === 'mock') return `[mock:${source}→${target}] ${text}`;
  return elnComplete(
    `You are a translation engine. Translate the user's text ${source === 'auto' ? '' : `from ${source} `}into ${target}. `
      + 'Reply with the translation only: no quotes, notes or explanations. Keep line breaks.',
    text, options);
}

/** Summarize text in its own language. Mock output is `[mock:summary] <first 80 chars>`. */
export async function elnSummarize(text: string, options: ElnLlmOptions = {}): Promise<string> {
  const env = options.env ?? process.env as ElnLlmEnv;
  if (elnCapabilityMode('summarization', env) === 'mock') return `[mock:summary] ${text.slice(0, 80)}`;
  return elnComplete('Summarize the user text in the same language in at most five short bullet points.', text, options);
}
