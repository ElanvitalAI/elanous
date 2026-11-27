// RESOURCE-FACTS defaults — the LAST resort. Every value here is used only when neither the world registry nor the
// policy file answers, and each use is logged («default used») so the guardian knows which fact it still has to own.
// This is the one place in src/ allowed to spell host / account / model names and expiry dates (resource-facts ratchet).
import type { Caps, HostFact, LlmRouting, ReviewPolicy } from './types.js';

type DefaultHost = Omit<HostFact, 'source' | 'note' | 'ncpu'> & { ncpu?: number | null };

/** Host census 11-27 — mbp = review/hand/pregate host, not in the RES test pre-approval pool; paid set = res-policy cloudHosts
 *  (guardian-agent/hosts.ts LOCAL_HOSTS ⊕ PAID_HOSTS ⊕ pregate.py FALLBACK_HOSTS ⊕ res-policy cloudHosts). */
export const DEFAULT_HOSTS: readonly DefaultHost[] = [
  { host: 'minim5', roles: ['test', 'gate', 'review', 'hand'], paid: false, paidApproved: false, hq: false, health: 'unknown', priority: 1 },
  { host: 'mbp', roles: ['gate', 'review', 'hand'], paid: false, paidApproved: false, hq: false, health: 'unknown', priority: 2 },
  { host: 'node-b', roles: ['test', 'gate', 'review', 'hand'], paid: false, paidApproved: false, hq: false, health: 'unknown', priority: 3 },
  { host: 'node-c', roles: ['test', 'gate', 'hand'], paid: false, paidApproved: false, hq: false, health: 'unknown', priority: 4 },
  { host: 'mshq', roles: ['hand'], paid: false, paidApproved: false, hq: true, health: 'unknown', priority: 9 },
  { host: 'aws1', roles: ['test', 'gate', 'burst'], paid: true, paidApproved: false, hq: false, health: 'unknown', priority: 10 },
  { host: 'aws2', roles: ['test', 'gate', 'burst'], paid: true, paidApproved: false, hq: false, health: 'unknown', priority: 11 },
  { host: 'aws3', roles: ['test', 'gate', 'burst'], paid: true, paidApproved: false, hq: false, health: 'unknown', priority: 11.5 },
  { host: 'gcp1', roles: ['test', 'gate', 'burst'], paid: true, paidApproved: false, hq: false, health: 'unknown', priority: 12 },
  { host: 'gcp2', roles: ['test', 'gate', 'burst'], paid: true, paidApproved: false, hq: false, health: 'unknown', priority: 13 },
];

/** Measured warm worker limits; unlisted host/tier pairs have no capacity. */
export const DEFAULT_WARM_POOL_QUOTAS: Readonly<Record<string, Readonly<Partial<Record<'lite' | 'standard', number>>>>> = {
  'node-b': { standard: 16 }, 'node-c': { standard: 4 }, 'elangram-wsl': { standard: 5 },
  'host-e-wsl': { standard: 5 }, 'gcp1': { standard: 2 }, 'aws1': { standard: 2 },
  'aws2': { standard: 2 }, 'mbp': { lite: 7 },
};

/** CEO 11-11 16:4x: Terra first · grok after 2 overload failures on the same head · grok not at ≥70 % · never GLM.
 *  CEO 11-27 10:0x: Claude ACP when healthy · 11-27 (OP «unblock today»): grok at once when every Terra route is unavailable. */
export const DEFAULT_REVIEW: ReviewPolicy = {
  primary: 'terra', fallback: 'grok', fallbackAfterFailures: 2, fallbackMaxUsedPercent: 70, forbidden: ['glm'],
  also: ['claude'], fallbackWhenPrimaryUnavailable: true,
};

/** LLM-ROUTE-BY-GUARDIAN routes × uses (CEO 11-27 10:0x «정책 문제 · 고정값이 문제»). Review is derived from DEFAULT_REVIEW.
 *  Route order matters only for review (primary family routes in this order). */
export const DEFAULT_LLM: LlmRouting = {
  alarmTo: 'OP',
  routes: {
    'terra-third': { provider: 'codex', accounts: ['third'], engine: 'terra', model: 'gpt-6.1-terra', cost: 'subscription', env: { ELANOUS_CODEX_ACCOUNT: 'third' }, owner: 'RES' },
    'terra-team': { provider: 'codex', accounts: ['team'], engine: 'terra', model: 'gpt-6.1-terra', cost: 'subscription', env: { ELANOUS_CODEX_ACCOUNT: 'team' }, owner: 'RES' },
    'terra-default': { provider: 'codex', accounts: ['default'], engine: 'terra', model: 'gpt-6.1-terra', cost: 'subscription', owner: 'RES' },
    'luna-default': { provider: 'codex', accounts: ['default'], engine: 'luna', model: 'gpt-6-luna', cost: 'subscription', owner: 'RES' },
    'luna-team': { provider: 'codex', accounts: ['team'], engine: 'luna', model: 'gpt-6-luna', cost: 'subscription', env: { ELANOUS_CODEX_ACCOUNT: 'team' }, owner: 'RES' },
    'luna-third': { provider: 'codex', accounts: ['third'], engine: 'luna', model: 'gpt-6-luna', cost: 'subscription', env: { ELANOUS_CODEX_ACCOUNT: 'third' }, owner: 'RES' },
    'claude-acp': { provider: 'claude', accounts: ['default'], engine: 'claude-acp', model: 'opus', cost: 'subscription', owner: 'OP' },
    'grok': { provider: 'grok', accounts: ['default'], engine: 'grok', model: 'grok-4.7', cost: 'subscription', owner: 'RES' },
    'glm-plan': { provider: 'zai', accounts: ['plan-5h', 'plan-week'], engine: 'glm', model: 'glm-5.3', cost: 'subscription', owner: 'RES' },
    'glm-openrouter': { provider: 'openrouter', accounts: ['default'], engine: 'glm', model: 'z-ai/glm-5.3', cost: 'credits', owner: 'RES' },
  },
  uses: {
    'compaction': { order: ['glm-plan', 'glm-openrouter', 'luna-default', 'luna-team', 'luna-third', 'terra-default'], pick: 'cheapest' },
    'capsule': { order: ['luna-default', 'luna-team', 'luna-third', 'glm-plan', 'glm-openrouter', 'terra-default'] },
    'hand-hard': { order: ['terra-default', 'terra-team', 'terra-third', 'luna-default', 'glm-plan', 'glm-openrouter'] },
    'hand-medium': { order: ['luna-default', 'luna-team', 'luna-third', 'glm-plan', 'glm-openrouter', 'terra-default'] },
    'hand-easy': { order: ['glm-plan', 'glm-openrouter', 'luna-default', 'luna-team', 'luna-third'] },
    'voice': { order: ['luna-default', 'luna-team', 'glm-plan', 'glm-openrouter'] },
    'ta': { order: ['terra-default', 'terra-team', 'terra-third', 'luna-default', 'glm-plan', 'glm-openrouter'] },
  },
};
export const DEFAULT_CAPS: Caps = {
  accountCap: 0.95,
  fuelLow: 0.9,
  grokWeeklyExhaustedPercent: 70,
  claudeSwitchPercent: 85,
  codexDefaultCapPercent: 95,
};

export const DEFAULT_ACCOUNT_NAMES: Readonly<Record<string, readonly string[]>> = {
  'openai-codex': ['team', 'third', 'default'],
};

/** Named expiries. `review-auto-chain` = the OP review auto-chain window (was END=2026-11-21 in the script). */
export const DEFAULT_EXPIRIES: Readonly<Record<string, string>> = {
  'review-auto-chain': '2026-11-21T23:59:59+09:00',
};

/** tsc-timeout re-run order (land.graph.retryHosts default). */
export const DEFAULT_RETRY_HOSTS: readonly string[] = ['node-b', 'minim5', 'mbp'];
