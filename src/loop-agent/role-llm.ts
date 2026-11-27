// kit/loop-shell · role-llm (PLATFORM-KITS-DUPLICATION-MAP-1127 §1-1): ONE role LLM for every loop agent voice.
// Before: judge-butler `configuredVoiceLlm` and loop-agent `configuredRoleLlm` were letter-for-letter copies that called
// `provider.chat` directly — outside streamLLM, so outside the usage records and the spend-policy junction. Now both (and the
// guardian, which imports the butler's) go through `streamLLM` with the resolved provider/model, a usage role and a usage site
// (`loop-agent:<id>`), so a loop voice turn is a recorded LLM call like any other. The spend gate decides for explicit
// providers by its own rule (streamLLM · liveSpendEligible) — this module does not keep a second copy of that rule.
// SUPERVISOR-CORRECTION-JOURNAL (CEO «기억·캐릭터가 있어서 대화 가능한 시점은?»): after the configured role, the voice walks the
// router-tier ladder of graphs/policies/loop-agent-journal.yaml `voice.fallback` (provider × tier → model via the tier map ·
// no fixed model). A candidate that throws or streams nothing is skipped for the rest of the process (an exhausted provider);
// when every candidate fails the last error surfaces and the agent folds to its journal ⊕ memory.
export interface VoiceLlm { complete(system: string, user: string): Promise<{ text: string; model: string }> }

export interface RoleLlmDeps {
  /** role → {provider, model} (user-config resolveRoleLlm) · null = no LLM configured for the role */
  resolve(role: string): { provider: string; model: string } | null;
  /** the provider object for that name/model (llm.ts getProviderForConfig) · null = unavailable */
  provider(name: string, model: string): unknown | null;
  /** streamLLM (llm.ts) */
  stream(messages: Array<{ role: 'system' | 'user'; content: string }>, opts: Record<string, unknown>): Promise<string>;
  /** Router-tier fallbacks after the role's own choice ({provider, model} resolved from the tier map) · omitted = none. */
  fallbacks?(role: string): ReadonlyArray<{ provider: string; model: string }>;
}

/** provider/model pairs that threw or streamed nothing in this process (an exhausted provider is not asked again). */
const exhausted = new Set<string>();
export const resetExhaustedVoiceProviders = (): void => exhausted.clear();

export function liveRoleLlmDeps(): RoleLlmDeps {
  return {
    resolve(role) {
      const uc = require('../user-config.js') as typeof import('../user-config.js');
      const r = uc.resolveRoleLlm(role as Parameters<typeof uc.resolveRoleLlm>[0], { config: uc.getUserConfig() });
      return r?.provider && r.model ? { provider: r.provider, model: r.model } : null;
    },
    provider(name, model) {
      const uc = require('../user-config.js') as typeof import('../user-config.js');
      const cfg = uc.getUserConfig();
      const { getProviderForConfig } = require('../llm.js') as typeof import('../llm.js');
      const p = getProviderForConfig({ ...cfg, llm: { ...cfg.llm, provider: name, model } } as typeof cfg, model);
      return p.available() ? p : null;
    },
    async stream(messages, opts) {
      const { streamLLM } = require('../llm.js') as typeof import('../llm.js');
      return streamLLM(messages as Parameters<typeof streamLLM>[0], () => {}, opts as Parameters<typeof streamLLM>[2]);
    },
    fallbacks() {
      const { readJournalPolicy } = require('./journal.js') as typeof import('./journal.js');
      const { lookupLlmTierSpec } = require('../model-tier/llm-tier-map.js') as typeof import('../model-tier/llm-tier-map.js');
      return readJournalPolicy().voiceFallback.flatMap(f => {
        try { return [{ provider: f.provider, model: lookupLlmTierSpec(f.provider as Parameters<typeof lookupLlmTierSpec>[0], f.tier as Parameters<typeof lookupLlmTierSpec>[1]).model }]; } catch { return []; }
      });
    },
  };
}

/** The voice LLM of `role` for one loop agent (`site` = usage site, e.g. `loop-agent:judge-butler`) · null = none configured. */
export function roleLlm(role: string, opts: { maxTokens?: number; site: string; timeoutMs?: number }, deps: RoleLlmDeps = liveRoleLlmDeps()): VoiceLlm | null {
  try {
    const r = deps.resolve(role);
    if (!r) return null;
    const seen = new Set<string>();
    const ladder = [r, ...(deps.fallbacks?.(role) ?? [])].filter(c => { const k = `${c.provider}/${c.model}`; if (seen.has(k)) return false; seen.add(k); return true; });
    const live = ladder.flatMap(c => { try { const p = deps.provider(c.provider, c.model); return p ? [{ ...c, p }] : []; } catch { return []; } });
    if (!live.length) return null;
    return {
      async complete(system, user) {
        let last: unknown = null;
        const fresh = live.filter(c => !exhausted.has(`${c.provider}/${c.model}`));
        for (const c of fresh.length ? fresh : live) {
          try {
            const text = await deps.stream([{ role: 'system', content: system }, { role: 'user', content: user }],
              { provider: c.p, model: c.model, maxTokens: opts.maxTokens ?? 900, signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000), usageRole: 'coordinator', usageSite: opts.site });
            if (!text.trim()) throw new Error(`${c.provider}/${c.model}: empty stream`);
            return { text, model: `${c.provider}/${c.model}` };
          } catch (e) { last = e; if (live.length > 1) exhausted.add(`${c.provider}/${c.model}`); }
        }
        throw last instanceof Error ? last : new Error(String(last));
      },
    };
  } catch { return null; }
}
