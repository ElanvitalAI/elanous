// RESOURCE-FACTS-FROM-LEDGER — the shape of every resource fact (hosts · LLM accounts · caps · review routing · expiries).
// S: CEO 11-27 10:4x «수호자가 원장으로 관리해야 할 것들을 고정값으로 쓰는 게 큰 문제» — host lists in 9 places (they differ;
//    one even routes tsc to the HQ host), review engine pinned to one model in 3 places, caps and expiry dates as literals.
// C: a fact changed in the world (a host goes bad, a reviewer falls back, a cap moves) needed a code change in every copy.
// Q: what is the one shape callers read, and where does each value come from?
// A: `ResourceFacts` below, resolved by `resourceFacts()` in three layers — world registry (lease ledger `world-actor` rows,
//    guardian-owned) over one policy file under state (OP/RES/guardian edit it) over code defaults (last resort, logged).
//    Faces: observe = every fact carries its `source`; judge = `pickHost` (route.ts) explains each skip; heal = an OP/RES
//    ledger line or a policy edit takes effect within the cache TTL — no code change, no restart.

/** What a host may be used for. A purpose (route.ts) maps onto one role. */
export const HOST_ROLES = ['test', 'gate', 'review', 'hand', 'burst'] as const;
export type HostRole = typeof HOST_ROLES[number];

/** Health as the registry declares it. Only `healthy` (and `unknown`) hosts are routed. */
export const HOST_HEALTH = ['healthy', 'unhealthy', 'reserved', 'unknown'] as const;
export type HostHealth = typeof HOST_HEALTH[number];

export type FactSource = 'ledger' | 'policy' | 'default';

export interface HostFact {
  readonly host: string;
  readonly roles: readonly HostRole[];
  /** A paid VM (cloud). Never routed unless `paidApproved`. */
  readonly paid: boolean;
  readonly paidApproved: boolean;
  /** The HQ canonical host — never runs heavy work (HQ_HEAVY_FORBIDDEN), whatever its roles say. */
  readonly hq: boolean;
  readonly health: HostHealth;
  /** Lower = preferred among equally loaded hosts. */
  readonly priority: number;
  readonly ncpu: number | null;
  /** Why the health is what it is (ledger reason / policy note). */
  readonly note: string | null;
  readonly source: FactSource;
}

export interface LlmAccountFact {
  /** `<provider>:<account>` (e.g. `openai-codex:team`). */
  readonly id: string;
  readonly provider: string;
  readonly account: string;
  /** 0..100, null = unknown. */
  readonly usedPercent: number | null;
  readonly source: FactSource;
}

export interface ReviewPolicy {
  /** The reviewer asked first (a model id or family, matched case-insensitively as a substring). */
  readonly primary: string;
  /** Who reviews after `fallbackAfterFailures` overload failures on the same head (CEO 11-11). */
  readonly fallback: string | null;
  readonly fallbackAfterFailures: number;
  /** The fallback is skipped when its own usage is at/over this percent. */
  readonly fallbackMaxUsedPercent: number;
  /** Families never accepted as a review (CEO: no GLM). */
  readonly forbidden: readonly string[];
  /** Families asked between primary and fallback while healthy (e.g. Claude ACP). */
  readonly also: readonly string[];
  /** The fallback is also taken at once when every primary route is unavailable (at cap · no credentials · unhealthy). */
  readonly fallbackWhenPrimaryUnavailable: boolean;
}

/** One LLM route = one provider account × model (LLM-ROUTE-ONE-SOURCE: the router's table lives here, nowhere else). */
export interface LlmRouteFact {
  readonly provider: string;
  /** Usage-snapshot accounts this route draws from; the fullest one counts. */
  readonly accounts: readonly string[];
  readonly engine: string;
  readonly model: string;
  readonly cost: 'subscription' | 'credits' | 'paid';
  readonly env?: Readonly<Record<string, string>>;
  readonly owner?: string;
}
/** A use's candidate order and rules (review is not here — it is derived from `review` above). */
export interface LlmUseFact {
  readonly order: readonly string[];
  readonly pick?: 'first' | 'cheapest';
  readonly whenAllDown?: 'cheapest' | 'wait';
  readonly forbidEngines?: readonly string[];
}
export interface LlmRouting {
  readonly routes: Readonly<Record<string, LlmRouteFact>>;
  readonly uses: Readonly<Record<string, LlmUseFact>>;
  /** Who gets the 🚨 line when a use falls back. */
  readonly alarmTo: string;
}

/** Usage caps and thresholds as fractions 0..1 unless the key says Percent. */
export interface Caps {
  /** New cells step a model tier down at this share (MODEL-BY-DIFFICULTY ACCOUNT_CAP · 연료관 exhausted). */
  readonly accountCap: number;
  /** 연료관 alerts OP at this share (before the cap). */
  readonly fuelLow: number;
  /** grok weekly window counts as exhausted at this used percent. */
  readonly grokWeeklyExhaustedPercent: number;
  /** Claude 5h window: move the shared OP/OPC seat off Claude past this used percent. */
  readonly claudeSwitchPercent: number;
  /** Codex default-account cap (percent). */
  readonly codexDefaultCapPercent: number;
  readonly [key: string]: number;
}

export interface ResourceFacts {
  readonly hosts: readonly HostFact[];
  readonly warmPoolQuotas: Readonly<Record<string, Readonly<Partial<Record<'lite' | 'standard', number>>>>>;
  readonly accounts: readonly LlmAccountFact[];
  /** Account names per provider (e.g. openai-codex → team · third · default). */
  readonly accountNames: Readonly<Record<string, readonly string[]>>;
  readonly review: ReviewPolicy;
  readonly llm: LlmRouting;
  readonly caps: Caps;
  /** Named expiries (ISO). A caller asks `expiryOf(name)` instead of carrying a date literal. */
  readonly expiries: Readonly<Record<string, string>>;
  /** Hosts for tsc-timeout re-runs, in order (land.graph.retryHosts). Empty = derive from `hostsFor('tsc')`. */
  readonly retryHosts: readonly string[];
  /** CODEX-CREDIT-ACCOUNTS — per provider, the only accounts allowed to spend paid credits once their subscription window
   *  is full (CEO 11-27 15:1x: team·third stop at 100 %, default goes on into credits). A provider with no entry = no
   *  restriction (every account with a measured balance, the old behavior). No code default: absent means absent. */
  readonly creditAccounts: Readonly<Record<string, readonly string[]>>;
  readonly resolvedAt: string;
  /** Which layers answered (and every warning: missing ledger, bad policy, default used). */
  readonly sources: readonly FactSource[];
  readonly warnings: readonly string[];
}

/** The policy file (under state) — every field optional; a missing field falls through to the code default. */
export interface PolicyFile {
  readonly warmPoolQuotas?: Readonly<Record<string, Readonly<Partial<Record<'lite' | 'standard', number>>>>>;
  readonly hosts?: Readonly<Record<string, Partial<Pick<HostFact, 'roles' | 'paid' | 'paidApproved' | 'hq' | 'health' | 'priority' | 'ncpu' | 'note'>>>>;
  readonly accountNames?: Readonly<Record<string, readonly string[]>>;
  readonly review?: Partial<ReviewPolicy>;
  /** Routes / uses replace same-named defaults; alarmTo replaces the default. */
  readonly llm?: { readonly routes?: Readonly<Record<string, LlmRouteFact>>; readonly uses?: Readonly<Record<string, LlmUseFact>>; readonly alarmTo?: string };
  readonly caps?: Readonly<Record<string, number>>;
  readonly expiries?: Readonly<Record<string, string>>;
  readonly retryHosts?: readonly string[];
  readonly creditAccounts?: Readonly<Record<string, readonly string[]>>;
}
