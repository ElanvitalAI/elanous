// ALLOCATION-BUDGET policy — budgets are data on the lease ledger (`alloc-budget-policy` rows written by OP · RES · GUARDIAN);
// the values below are only the fallback when no such row exists yet (OPS «운영 config 최소화 · 기본값은 코드로»).
import type { AllocBudgetPolicy, AllocBudgetPolicyEvent, AllocPurposeKind } from './alloc-events.js';
import { ALLOC_PURPOSE_KINDS } from './alloc-events.js';

/** Who may author a budget row that the allocator trusts (others are kept in the ledger but ignored). */
export const POLICY_WRITERS = ['OP', 'RES', 'GUARDIAN', 'loop:guardian'] as const;

export const DEFAULT_ALLOC_POLICY: AllocBudgetPolicy = {
  version: 'default-1127',
  providers: {
    // 95 % = MODEL-BY-DIFFICULTY ACCOUNT_CAP = 연료관 FUEL_EXHAUSTED (new cells step a tier down there).
    codex: { windowCapPct: 95, stepDownTo: 'openrouter' },
    claude: { windowCapPct: 95, stepDownTo: 'codex' },
    zai: { windowCapPct: 95, stepDownTo: 'openrouter' },
    // grok: OP rule 11-11 «grok 사용량 70% 이상이면 쓰지 않음».
    grok: { windowCapPct: 70, stepDownTo: 'openrouter' },
    // OpenRouter = paid credits (CEO: allowed, tracked against the daily cap).
    // A paid request without its own estimate reserves estUsdPerGrant until the release settles the real $ (no unbounded grants).
    openrouter: { paid: true, dailyUsd: 50, estUsdPerGrant: 0.25 },
  },
  paidDailyCapUsd: 50,
  alertAtPct: 80,
  scarceAtPct: 80,
  seatShareMaxPct: 40,
  purposeCeilingPct: { 'p0-cell': 100, cut: 100, review: 95, gate: 95, work: 90, compaction: 90, voice: 80, experiment: 70, unspecified: 85 },
  // 컷·발행 창 (KST 03:00–06:30 · CEO «컷은 늦게 · 발행 06:00»).
  cutWindow: { start: '03:00', end: '06:30', reservePct: 20 },
  // Host capacity is RES's call; unlisted hosts are unmeasured (granted and recorded, never blocked).
  hostSlots: {},
  // Empty = the resource-facts host census (unpaid, non-HQ, by priority) at grant time — no host names in code (RESOURCE-FACTS).
  hostOrder: [],
};

/** Provider names follow the usage snapshot (codex · claude · grok · openrouter · zai); router spellings fold in. */
export function normalizeProvider(p: string): string {
  const v = p.trim().toLowerCase();
  return v === 'openai-codex' || v === 'openai' ? 'codex' : v === 'anthropic' ? 'claude' : v === 'glm' || v === 'z-ai' ? 'zai' : v === 'xai' ? 'grok' : v;
}

export const purposeRank = (k: AllocPurposeKind): number => ALLOC_PURPOSE_KINDS.indexOf(k);
export const isUrgent = (k: AllocPurposeKind): boolean => k === 'p0-cell' || k === 'cut';

/** Merge a partial policy over a base: top-level fields replace, nested maps merge key by key (a provider entry field by field). */
export function mergePolicy(base: AllocBudgetPolicy, p: Partial<AllocBudgetPolicy>): AllocBudgetPolicy {
  const providers: Record<string, AllocBudgetPolicy['providers'][string]> = { ...base.providers };
  for (const [k, v] of Object.entries(p.providers ?? {})) providers[k] = { ...(base.providers[k] ?? {}), ...v };
  return { ...base, ...p, providers, purposeCeilingPct: { ...base.purposeCeilingPct, ...p.purposeCeilingPct },
    cutWindow: { ...base.cutWindow, ...p.cutWindow }, hostSlots: { ...base.hostSlots, ...p.hostSlots },
    ...(base.vmHourlyUsd || p.vmHourlyUsd ? { vmHourlyUsd: { ...base.vmHourlyUsd, ...p.vmHourlyUsd } } : {}) };
}

/** The latest trusted policy row merged over the defaults (a row may set only some fields). */
export function effectivePolicy(events: readonly { event: string }[]): AllocBudgetPolicy & { source: string } {
  const row = [...events].reverse().find((e): e is AllocBudgetPolicyEvent =>
    e.event === 'alloc-budget-policy' && (POLICY_WRITERS as readonly string[]).includes((e as AllocBudgetPolicyEvent).by));
  const base = row ? mergePolicy(DEFAULT_ALLOC_POLICY, row.policy) : DEFAULT_ALLOC_POLICY;
  const source = row ? `${row.by}@${row.at}` : 'default';
  // LLM-ACCOUNT-POLICY-WIRING: the grok weekly cap is the policy pack's (one source) — a trusted budget row overrides it
  // only when that row itself sets grok's windowCapPct; the code default is the last fallback.
  if (row?.policy.providers?.grok?.windowCapPct !== undefined) return { ...base, source };
  let grokCap: number | undefined;
  try { grokCap = (require('../kit/resource-facts/llm-decide.js') as typeof import('../kit/resource-facts/llm-decide.js')).decidedGrokWeeklyCap('alloc-budget'); } catch { grokCap = undefined; }
  if (grokCap === undefined || !base.providers.grok) return { ...base, source };
  return { ...mergePolicy(base, { providers: { grok: { ...base.providers.grok, windowCapPct: grokCap } } }), source: `${source} ⊕ llm-accounts` };
}

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
/** KST wall-clock minutes of the day. */
export const kstMinutes = (now: Date): number => (now.getUTCHours() * 60 + now.getUTCMinutes() + 540) % 1440;
/** KST calendar day (YYYY-MM-DD). */
export const kstDay = (now: Date): string => new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
export function inCutWindow(policy: AllocBudgetPolicy, now: Date): boolean {
  const m = kstMinutes(now); const s = minutes(policy.cutWindow.start); const e = minutes(policy.cutWindow.end);
  return s <= e ? m >= s && m < e : m >= s || m < e;
}
