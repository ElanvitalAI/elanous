/** Observation boundary for HTTP LLM sends and delegated prompts. Never inspect or log credentials, bodies or URL path/query. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { debug, getAmbientParentSessionId, getAmbientSessionId } from '../debug/log.js';
import { processTuiLogTag } from '../debug/tui-log-tag.js';

export type LlmCallSelectionSource = 'session' | 'config' | 'explicit' | 'fallback';
export type LlmCallBilling = 'subscription' | 'credits' | 'apikey';
export interface LlmCallContext {
  provider?: string;
  model?: string;
  sessionId?: string;
  parentSessionId?: string;
  role?: 'main' | 'child' | 'aux';
  requestedBy?: string;
  selectionSource?: LlmCallSelectionSource;
  billing?: LlmCallBilling;
  /** What the caller (or the screen) asked for. When it differs from the provider/model actually called, one `mismatch` warn row follows the attempt row. */
  requestedProvider?: string;
  requestedModel?: string;
}
const context = new AsyncLocalStorage<LlmCallContext>();
export function withLlmCallContext<T>(fields: LlmCallContext, work: () => T): T {
  return context.run({ ...context.getStore(), ...fields }, work);
}

/** Exactly one attempt row, emitted BEFORE the network send (including rejected/aborted sends). */
export function llmNetworkFetch(url: string | URL, init: RequestInit, fields: LlmCallContext = {}): Promise<Response> {
  return llmNetworkSend(url, init, fields, () => fetch(url, init));
}

/** Injected transports use the same observation boundary without replacing the transport. */
export function llmNetworkSend(
  url: string | URL, _init: RequestInit, fields: LlmCallContext, send: () => Promise<Response>,
): Promise<Response> {
  return llmObserveSend(url, fields, send);
}

/** Observe non-fetch transports (including SDKs) at their actual invocation, preserving their native result type. */
export function llmObserveSend<T>(url: string | URL, fields: LlmCallContext, send: () => T): T {
  return observeSend(url, fields, send, 'llm.call', 'attempt');
}

/** Observe an ACP/PTY prompt dispatch, not an HTTP inference attempt inside the delegated process. */
export function llmObserveDelegation<T>(fields: LlmCallContext, send: () => T): T {
  return observeSend(null, fields, send, 'llm.delegate', 'prompt');
}

/** Declared-name ↔ wire-name aliases. The provider registry calls the subscription
 *  backend `openai-codex` (provider.name), the wire transport says `codex`
 *  (retryOptsFor('codex', …) → retry-api.ts). Same backend — without symmetric
 *  normalization every codex call fired one mismatch warn row (24h 실측 38,395/41,683
 *  attempt ≈ 92%가 이 별칭쌍 · LLM-CALL-LEDGER-NO-GAP). Comparison-only: emitted rows
 *  keep the raw names. */
const PROVIDER_NAME_ALIASES: Readonly<Record<string, string>> = { 'openai-codex': 'codex' };
function canonicalProviderName(name: string): string {
  return PROVIDER_NAME_ALIASES[name] ?? name;
}

function observeSend<T>(
  url: string | URL | null, fields: LlmCallContext, send: () => T,
  category: 'llm.call' | 'llm.delegate', event: 'attempt' | 'prompt',
): T {
  try {
    const scoped = { ...context.getStore(), ...fields };
    // URL.hostname strips path, query, credentials and port; never fall back to the input URL on parse failure.
    // Delegated prompts have no observable HTTP URL and always report host:null.
    let host: string | null = null;
    if (url !== null) {
      try { host = new URL(url).hostname || null; } catch { /* malformed URL is still sent to fetch */ }
    }
    const sessionId = scoped.sessionId ?? getAmbientSessionId() ?? processTuiLogTag().session?.() ?? null;
    const parentSessionId = scoped.parentSessionId ?? getAmbientParentSessionId() ?? null;
    const provider = scoped.provider ?? 'unknown';
    const billing = scoped.billing ?? (provider === 'openai-codex' || provider === 'codex' ? 'subscription'
      : provider === 'openrouter' || provider === 'opengateway' || provider === 'hq-proxy' ? 'credits' : 'apikey');
    debug.log(category, event, {
      provider, model: scoped.model ?? null, host, sessionId, tuiPid: processTuiLogTag().pid,
      parentSessionId, role: scoped.role ?? (parentSessionId ? 'child' : 'main'),
      requestedBy: scoped.requestedBy ?? 'provider', selectionSource: scoped.selectionSource ?? 'config', billing,
    });
    // Declared != observed: exactly one extra warn line, only when a requested value was declared and differs (never inferred).
    const model = scoped.model ?? null;
    const providerDiffers = scoped.requestedProvider !== undefined
      && canonicalProviderName(scoped.requestedProvider) !== canonicalProviderName(provider);
    const modelDiffers = scoped.requestedModel !== undefined && scoped.requestedModel !== model;
    if (providerDiffers || modelDiffers) {
      debug.log(category, 'mismatch', {
        requestedProvider: scoped.requestedProvider ?? null, provider, requestedModel: scoped.requestedModel ?? null, model,
        sessionId, tuiPid: processTuiLogTag().pid, requestedBy: scoped.requestedBy ?? 'provider',
      }, { level: 'warn' });
    }
  } catch { /* telemetry must never alter transport behavior */ }
  return send();
}
