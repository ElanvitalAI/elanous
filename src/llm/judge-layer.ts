import { debug } from '../debug/log.js';
import { resolveRoleLlm, type UserConfig } from '../user-config.js';
import type { ResolveRoleProviderFn, StreamLlmFn } from '../intake-plane/runtime-callables.js';

interface JudgeReply {
  text: string;
  promptTokens?: number;
  completionTokens?: number;
  costUsd?: number;
  modelId?: string;
}

interface JudgeOptions<T = string> {
  site: string;
  prompt: string;
  messages?: Array<{ role: 'user' | 'system' | 'assistant'; content: string }>;
  /** Return null when the parsed decision is not usable. */
  schema?: (value: unknown) => T | null;
  signal?: AbortSignal;
  /** Injectable transport for callers with an existing LLM callable. */
  call?: (args: { prompt: string; signal?: AbortSignal; provider: string; model: string }) => Promise<JudgeReply>;
  streamLLM?: StreamLlmFn;
  resolveRoleProvider?: ResolveRoleProviderFn;
  /** Optional config slice for deterministic role resolution in isolated callers. */
  config?: UserConfig;
}

type JudgeResult<T> =
  | { ok: true; value: T; reply: JudgeReply; provider: string; model: string }
  | { ok: false; reason: 'call'; error: unknown }
  | { ok: false; reason: 'schema'; rawText: string };

/** Marks a judge call that ran on an injected transport with no configured provider. */
export const UNRESOLVED = 'unresolved';

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)```/);
  const candidate = fence ? fence[1]!.trim() : trimmed;
  try { return JSON.parse(candidate); } catch { /* Models can prefix a JSON object with prose. */ }
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(candidate.slice(start, end + 1)); } catch { return null; }
}

/** One role-scoped classification call; errors and invalid decisions leave rule fallback to the caller. */
export async function judge<T = string>(opts: JudgeOptions<T>): Promise<JudgeResult<T>> {
  const started = Date.now();
  let provider = '';
  let model = '';
  let ok = false;
  try {
    const picked = opts.resolveRoleProvider?.('classify');
    if (picked) {
      provider = picked.provider.name;
      model = picked.model ?? '';
    } else {
      try {
        const resolved = resolveRoleLlm('classify', opts.config ? { config: opts.config } : {});
        provider = resolved.provider;
        model = resolved.model;
      } catch (error) {
        // An injected transport does not need a configured provider; a real call still fails as before.
        if (!opts.call || (error as Error | undefined)?.name !== 'NoLlmProviderAvailableError') throw error;
        provider = UNRESOLVED;
        model = UNRESOLVED;
        try { debug.log('llm.judge', 'provider-unresolved', { site: opts.site }); } catch { /* fail-soft */ }
      }
    }
    const messages = opts.messages ?? [{ role: 'user' as const, content: opts.prompt }];
    let reply: JudgeReply;
    if (opts.call) {
      reply = await opts.call({ prompt: opts.prompt, signal: opts.signal, provider, model });
    } else {
      const llm = picked && opts.streamLLM ? undefined : await import('../llm.js');
      const transportProvider = picked?.provider ?? llm?.PROVIDERS[provider];
      if (!transportProvider) throw new Error(`Unknown classify provider: ${provider}`);
      const streamOpts = { ...(model ? { model } : {}), ...(opts.signal ? { signal: opts.signal } : {}), usageRole: 'classify' as const };
      if (opts.streamLLM) {
        reply = { text: await opts.streamLLM(messages, () => {}, {
          ...streamOpts, provider: transportProvider as ReturnType<ResolveRoleProviderFn>['provider'],
        }) };
      } else {
        const registeredProvider = llm?.PROVIDERS[provider];
        if (!llm || !registeredProvider) throw new Error(`Unknown classify provider: ${provider}`);
        reply = { text: await llm.streamLLM(messages, () => {}, { ...streamOpts, provider: registeredProvider }) };
      }
    }
    const value = opts.schema ? opts.schema(parseJson(reply.text)) : reply.text as T;
    if (value === null || value === undefined) return { ok: false, reason: 'schema', rawText: reply.text };
    ok = true;
    return { ok: true, value, reply, provider, model };
  } catch (error) {
    return { ok: false, reason: 'call', error };
  } finally {
    try {
      debug.log('llm.judge', 'call', { site: opts.site, provider, model, ms: Date.now() - started, ok });
    } catch { /* Observation must not turn an undecided call into an exception. */ }
  }
}
