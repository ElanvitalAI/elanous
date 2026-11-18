// TA-POD-REVIEW-PROVIDER-ALLOW (OP 11-18 · 대표 widened) — per-role provider chains for the Pod self-implement.
//
// Before this module the Pod review allowlist was a literal `['openai-codex']` in `dev-pipeline.ts`. Every
// judgement and recovery call shares that one reviewer, so an OpenRouter (glm) child Pod died in the recovery
// round with `no-usable-provider: openrouter(...)=provider-not-allowed, grok(...)=provider-not-allowed`.
//
// The chains are config (`llm.roleProviderChains`), with these defaults:
//   review · judgement → Terra (codex) → grok, only while grok usage is under 70% → OpenRouter luna
//   recovery           → OpenRouter glm → Terra (codex)
// Review · judgement use an ALLOWLIST (terra · grok · OpenRouter luna): every other model — GLM in any
// spelling, prefix or path variants included — is refused with an event, even when the config names it.
// An exhausted chain throws a reason naming the role and every candidate with why it was skipped.
import { inferProviderFromModel } from '../llm.js';
import { readCachedGrokQuota } from '../oauth/codex-account-store.js';
import { debug } from '../debug/log.js';

export type ProviderChainRole = 'review' | 'judgement' | 'recovery';
/** Raw `llm.roleProviderChains` (user-config keeps only string arrays; unknown roles are never read). */
type RoleProviderChainsConfig = Readonly<Record<string, readonly string[]>>;

const DEFAULT_ROLE_PROVIDER_CHAINS: Readonly<Record<ProviderChainRole, readonly string[]>> = {
  review: ['gpt-6.1-terra', 'grok-4.7', 'openrouter/openai/gpt-6-luna'],
  judgement: ['gpt-6.1-terra', 'grok-4.7', 'openrouter/openai/gpt-6-luna'],
  recovery: ['openrouter/z-ai/glm-5.3', 'gpt-6.1-terra'],
};

/**
 * 리뷰·판정 사슬 허용 목록 — 차단 목록이 아니다(JUD-B #90187 ③). 아래 세 모델만 통과하고 나머지 전부
 * (모든 GLM 표기 — `glm-5.3`, `z-ai-glm-5.3`, `openrouter/z-ai/glm-5.3:free` — 와 그 밖의 비허용 모델)는 거부된다.
 * 정규식 차단은 우회 표기를 놓치므로 폐기했다.
 */
const REVIEW_ALLOWED_BASENAMES: ReadonlySet<string> = new Set(['gpt-6.1-terra', 'grok-4.7', 'gpt-6-luna']);
function reviewModelAllowed(model: string): boolean {
  const base = model.trim().toLowerCase().split('/').pop()!.split(':')[0];
  return REVIEW_ALLOWED_BASENAMES.has(base);
}

type ChainCandidateWhy =
  | 'not-in-review-allowlist'
  | 'provider-unknown'
  | 'no-credential'
  | 'availability-check-failed'
  | 'grok-usage-at-or-above-70'
  | 'grok-usage-unmeasured';

export interface ChainCandidate { readonly model: string; readonly provider: string }
interface ChainSkip extends ChainCandidate { readonly why: ChainCandidateWhy }

interface RoleProviderChainResolution {
  readonly role: ProviderChainRole;
  readonly source: 'config' | 'default';
  /** Usable candidates, in chain order. */
  readonly candidates: readonly ChainCandidate[];
  readonly skipped: readonly ChainSkip[];
  /** Present only when `candidates` is empty: names the role and every candidate with its reason. */
  readonly exhaustedReason?: string;
}

interface RoleProviderChainDeps {
  readonly config?: { llm?: { roleProviderChains?: RoleProviderChainsConfig } };
  /** Whether this host can call the candidate (credential present). A throw counts as `availability-check-failed`. */
  readonly isAvailable: (candidate: ChainCandidate) => boolean;
  /** Grok usage against the 70% cap: `usable` below it, `exhausted` at or above it, `unknown` fails closed. */
  readonly grokQuota?: () => 'usable' | 'exhausted' | 'unknown';
  readonly providerOf?: (model: string) => string | null;
}

/** Resolve one role's chain. Never falls back silently: every refusal is in `skipped` and an event. */
export function resolveRoleProviderChain(role: ProviderChainRole, deps: RoleProviderChainDeps): RoleProviderChainResolution {
  const chains = deps.config?.llm?.roleProviderChains;
  // Own keys only: a config object must not answer a role through its prototype.
  const configured = chains && Object.hasOwn(chains, role) ? chains[role] : undefined;
  const source = configured && configured.length > 0 ? 'config' as const : 'default' as const;
  const models = source === 'config' ? configured! : DEFAULT_ROLE_PROVIDER_CHAINS[role];
  const providerOf = deps.providerOf ?? ((model: string) => inferProviderFromModel(model));
  const candidates: ChainCandidate[] = [];
  const skipped: ChainSkip[] = [];
  for (const model of models) {
    const provider = providerOf(model) ?? 'unknown';
    const skip = (why: ChainCandidateWhy) => { skipped.push({ model, provider, why }); };
    if (role !== 'recovery' && !reviewModelAllowed(model)) {
      skip('not-in-review-allowlist');
      debug.log('self-dev.role-chain', 'review-not-allowed', { role, model, source }, { level: 'warn' });
      continue;
    }
    if (provider === 'unknown') { skip('provider-unknown'); continue; }
    if (provider === 'grok') {
      let quota: 'usable' | 'exhausted' | 'unknown';
      try { quota = (deps.grokQuota ?? readCachedGrokQuota)(); } catch { quota = 'unknown'; }
      if (quota !== 'usable') { skip(quota === 'exhausted' ? 'grok-usage-at-or-above-70' : 'grok-usage-unmeasured'); continue; }
    }
    let available: boolean;
    try { available = deps.isAvailable({ model, provider }); } catch { skip('availability-check-failed'); continue; }
    if (!available) { skip('no-credential'); continue; }
    candidates.push({ model, provider });
  }
  if (candidates.length > 0) return { role, source, candidates, skipped };
  const tried = skipped.length ? skipped.map((s) => `${s.provider}(${s.model})=${s.why}`).join(', ') : 'no candidates configured';
  const exhaustedReason = `role-chain-exhausted: ${role}: ${tried}`;
  debug.log('self-dev.role-chain', 'exhausted', { role, source, tried: skipped }, { level: 'warn' });
  return { role, source, candidates, skipped, exhaustedReason };
}
