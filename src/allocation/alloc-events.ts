// ALLOCATION-BUDGET events inside the lease ledger (resource-ledger/events.jsonl) — not a new ledger
// (LOOP-AGENTS §1 «정본 원장 넷 · 새 tsv/json 원장 금지» · §2 rule 9 S4 «임대 reserve→grant→release»).
//   alloc.reserve       who (verified identity ⊕ parent chain) · purpose · resource · estimate · TTL · consumer
//   alloc.grant         the allocator's answer: granted / stepped-down (cheaper model · other host) / override (P0·cut never stall)
//   alloc.queue         not now — ETA (account window refill · earliest host lease end)
//   alloc.release       actual usage (tokens in/out · $ subscription vs paid · cpu-min) and the real duration
//   alloc.reclaim       the guardian (임대관) took back a lease whose TTL passed without a release
//   alloc-budget-policy budgets as data (OP · RES · GUARDIAN write; defaults in code are only the fallback)
//   alloc-reconcile     daily metered totals vs the provider usage snapshot (drift alert)
// Pure: types + validation only (resource-ledger.ts validates every line with this before it accepts or appends it).

export const ALLOC_IDENTITY_KINDS = ['seat', 'loop-agent', 'ta-card', 'graph-run', 'capsule', 'unattributed'] as const;
export type AllocIdentityKind = typeof ALLOC_IDENTITY_KINDS[number];

/** Where an identity link came from — never a free-text label typed by the caller. */
export type AllocIdentitySource = 'env:ELANOUS_TRACK' | 'env:ELANOUS_SEAT' | 'cwd:seats' | 'env:COORD_ID' | 'env:ELANOUS_LOOP_ID'
  | 'env:ELANOUS_LOOP_NAME' | 'env:ELANOUS_GRAPH_RUN_ID' | 'env:ELANOUS_TASK_CARD_ID' | 'env:ELANOUS_PARENT_RUN_ID' | 'env:ELANOUS_RUN_ID'
  | 'proxy:seat' | 'none';
export const ALLOC_IDENTITY_SOURCES: readonly AllocIdentitySource[] = ['env:ELANOUS_TRACK', 'env:ELANOUS_SEAT', 'cwd:seats', 'env:COORD_ID',
  'env:ELANOUS_LOOP_ID', 'env:ELANOUS_LOOP_NAME', 'env:ELANOUS_GRAPH_RUN_ID', 'env:ELANOUS_TASK_CARD_ID', 'env:ELANOUS_PARENT_RUN_ID',
  'env:ELANOUS_RUN_ID', 'proxy:seat', 'none'];

export interface AllocIdentityLink { readonly kind: AllocIdentityKind; readonly id: string; readonly source: AllocIdentitySource }
/** The principal is the innermost link (who actually spends); chain[0] is the outermost parent (e.g. seat:OP → capsule → ta-card). */
export interface AllocIdentity { readonly kind: AllocIdentityKind; readonly id: string; readonly source: AllocIdentitySource; readonly chain: readonly AllocIdentityLink[] }

/** Purpose priority, highest first (CEO 11-27: P0 cell > release cut > review > normal work > voice > experiments). */
export const ALLOC_PURPOSE_KINDS = ['p0-cell', 'cut', 'review', 'gate', 'work', 'compaction', 'voice', 'experiment', 'unspecified'] as const;
export type AllocPurposeKind = typeof ALLOC_PURPOSE_KINDS[number];
export interface AllocPurpose { readonly kind: AllocPurposeKind; readonly ref?: string; readonly inferred?: boolean }

export type AllocResource =
  | { readonly type: 'llm'; readonly provider: string; readonly account?: string; readonly model?: string }
  | { readonly type: 'host'; readonly host: string; readonly cpuSlots: number };

export interface AllocAmount { readonly tokens?: number; readonly usd?: number; readonly cpuMin?: number }
export type AllocBilling = 'subscription' | 'paid' | 'unknown';
export interface AllocUsage {
  readonly inputTokens?: number; readonly outputTokens?: number; readonly usd?: number; readonly billing?: AllocBilling;
  readonly cpuMin?: number; readonly host?: string;
  /** where the numbers came from: the caller · the ledger's llm-proxy-call rows · wall clock × slots · none */
  readonly basis: 'caller' | 'llm-proxy-call' | 'wall-clock' | 'none';
}

export const ALLOC_CONSUMERS = ['route-llm', 'route-host', 'pregate', 'ta-launch', 'capsule', 'seat-turn', 'hand', 'test', 'manual'] as const;
export type AllocConsumer = typeof ALLOC_CONSUMERS[number];

export type AllocGrantMode = 'granted' | 'stepped-down' | 'override';

export interface AllocBudgetPolicy {
  readonly version: string;
  /** per provider: daily/weekly $ (paid credits) · cap on the subscription window share · whether calls cost money */
  readonly providers: Readonly<Record<string, { readonly dailyUsd?: number; readonly weeklyUsd?: number; readonly windowCapPct?: number; readonly paid?: boolean; readonly stepDownTo?: string; readonly estUsdPerGrant?: number }>>;
  /** total paid $ per KST day across providers (CEO: paid credits allowed, tracked against a daily cap) */
  readonly paidDailyCapUsd: number;
  /** alert when a budget reaches this share */
  readonly alertAtPct: number;
  /** an account counts as scarce above this used share; then no single identity may take more than seatShareMaxPct of it */
  readonly scarceAtPct: number;
  readonly seatShareMaxPct: number;
  /** ceiling (share of the window cap) per purpose — P0/cut use the whole cap, the rest leave reserve */
  readonly purposeCeilingPct: Readonly<Partial<Record<AllocPurposeKind, number>>>;
  /** cut window (KST) — non-P0/cut purposes leave reservePct of every account and host */
  readonly cutWindow: { readonly start: string; readonly end: string; readonly reservePct: number };
  /** host cpu slots (capacity) — a host missing here is unmeasured: granted and recorded, never blocked */
  readonly hostSlots: Readonly<Record<string, number>>;
  /** host step-down order (other host) */
  readonly hostOrder: readonly string[];
  /** paid VM $/hour (budget advisor's burst estimate) — a host missing here is «$ 미상» */
  readonly vmHourlyUsd?: Readonly<Record<string, number>>;
  /** federation mode: build (구현) or maintenance (정비 — review/judge/finish first, new implementation paused) */
  readonly mode?: 'build' | 'maintenance';
}

export type AllocReserveEvent = { event: 'alloc.reserve'; at: string; id: string; who: AllocIdentity; purpose: AllocPurpose; resource: AllocResource; amount: AllocAmount; ttlMs: number; consumer: AllocConsumer };
export type AllocGrantEvent = { event: 'alloc.grant'; at: string; id: string; resource: AllocResource; expiresAt: string; mode: AllocGrantMode; reason: string; alerts: string[] };
export type AllocQueueEvent = { event: 'alloc.queue'; at: string; id: string; etaAt: string | null; reason: string };
export type AllocReleaseEvent = { event: 'alloc.release'; at: string; id: string; by: string; usage: AllocUsage };
export type AllocReclaimEvent = { event: 'alloc.reclaim'; at: string; id: string; by: string; reason: 'ttl-expired' };
export type AllocBudgetPolicyEvent = { event: 'alloc-budget-policy'; at: string; by: string; policy: AllocBudgetPolicy };
export interface AllocReconcileRow { readonly provider: string; readonly meteredUsd: number; readonly meteredTokens: number; readonly grants: number; readonly providerUsedPct: number | null; readonly deltaUsedPct: number | null; readonly alert: boolean; readonly why: string }
export type AllocReconcileEvent = { event: 'alloc-reconcile'; at: string; by: string; day: string; rows: AllocReconcileRow[] };

export type AllocLedgerEvent = AllocReserveEvent | AllocGrantEvent | AllocQueueEvent | AllocReleaseEvent | AllocReclaimEvent | AllocBudgetPolicyEvent | AllocReconcileEvent;

export const ALLOC_LEDGER_EVENT_TYPES = ['alloc.reserve', 'alloc.grant', 'alloc.queue', 'alloc.release', 'alloc.reclaim', 'alloc-budget-policy', 'alloc-reconcile'] as const;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,199}$/;
const text = (v: unknown, max: number) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const ts = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v));
const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const optNum = (v: unknown) => v === undefined || num(v);
const pct = (v: unknown) => num(v) && (v as number) <= 100;
const hhmm = (v: unknown) => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);

export const validAllocId = (v: unknown): v is string => typeof v === 'string' && ID.test(v);

function validLink(v: unknown): boolean {
  return isRec(v) && (ALLOC_IDENTITY_KINDS as readonly string[]).includes(String(v.kind)) && validAllocId(v.id)
    && ALLOC_IDENTITY_SOURCES.includes(v.source as AllocIdentitySource);
}
export function validAllocIdentity(v: unknown): v is AllocIdentity {
  return validLink(v) && Array.isArray((v as Record<string, unknown>).chain) && ((v as { chain: unknown[] }).chain).length <= 8
    && ((v as { chain: unknown[] }).chain).every(validLink);
}
export function validAllocPurpose(v: unknown): v is AllocPurpose {
  return isRec(v) && (ALLOC_PURPOSE_KINDS as readonly string[]).includes(String(v.kind))
    && (v.ref === undefined || text(v.ref, 200)) && (v.inferred === undefined || typeof v.inferred === 'boolean');
}
export function validAllocResource(v: unknown): v is AllocResource {
  if (!isRec(v)) return false;
  if (v.type === 'llm') return validAllocId(v.provider) && (v.account === undefined || text(v.account, 200)) && (v.model === undefined || text(v.model, 200));
  if (v.type === 'host') return validAllocId(v.host) && num(v.cpuSlots);
  return false;
}
const validAmount = (v: unknown) => isRec(v) && optNum(v.tokens) && optNum(v.usd) && optNum(v.cpuMin);
function validUsage(v: unknown): boolean {
  return isRec(v) && ['inputTokens', 'outputTokens', 'usd', 'cpuMin'].every(k => optNum(v[k]))
    && (v.billing === undefined || ['subscription', 'paid', 'unknown'].includes(String(v.billing)))
    && (v.host === undefined || validAllocId(v.host))
    && ['caller', 'llm-proxy-call', 'wall-clock', 'none'].includes(String(v.basis));
}
export function validAllocBudgetPolicy(v: unknown): v is AllocBudgetPolicy {
  if (!isRec(v) || !text(v.version, 100) || !isRec(v.providers) || !num(v.paidDailyCapUsd) || !pct(v.alertAtPct)
    || !pct(v.scarceAtPct) || !pct(v.seatShareMaxPct) || !isRec(v.purposeCeilingPct) || !isRec(v.cutWindow) || !isRec(v.hostSlots)
    || !Array.isArray(v.hostOrder)) return false;
  const providersOk = Object.entries(v.providers).every(([k, p]) => validAllocId(k) && isRec(p) && optNum(p.dailyUsd) && optNum(p.weeklyUsd)
    && (p.windowCapPct === undefined || pct(p.windowCapPct)) && (p.paid === undefined || typeof p.paid === 'boolean')
    && (p.stepDownTo === undefined || validAllocId(p.stepDownTo)) && optNum(p.estUsdPerGrant));
  const ceilingsOk = Object.entries(v.purposeCeilingPct).every(([k, c]) => (ALLOC_PURPOSE_KINDS as readonly string[]).includes(k) && pct(c));
  const cw = v.cutWindow;
  return providersOk && ceilingsOk && hhmm(cw.start) && hhmm(cw.end) && pct(cw.reservePct)
    && Object.entries(v.hostSlots).every(([h, n]) => validAllocId(h) && Number.isSafeInteger(n) && (n as number) >= 0)
    && v.hostOrder.every(validAllocId)
    && (v.vmHourlyUsd === undefined || (isRec(v.vmHourlyUsd) && Object.entries(v.vmHourlyUsd).every(([h, n]) => validAllocId(h) && num(n))))
    && (v.mode === undefined || v.mode === 'build' || v.mode === 'maintenance');
}

/** Validate one parsed ledger row of an alloc event type. */
export function validAllocLedgerEvent(row: Record<string, unknown>): boolean {
  if (!ts(row.at)) return false;
  switch (row.event) {
    case 'alloc.reserve':
      return validAllocId(row.id) && validAllocIdentity(row.who) && validAllocPurpose(row.purpose) && validAllocResource(row.resource)
        && validAmount(row.amount) && num(row.ttlMs) && (row.ttlMs as number) > 0 && (ALLOC_CONSUMERS as readonly string[]).includes(String(row.consumer));
    case 'alloc.grant':
      return validAllocId(row.id) && validAllocResource(row.resource) && ts(row.expiresAt)
        && ['granted', 'stepped-down', 'override'].includes(String(row.mode)) && text(row.reason, 500)
        && Array.isArray(row.alerts) && row.alerts.every(a => text(a, 500));
    case 'alloc.queue':
      return validAllocId(row.id) && (row.etaAt === null || ts(row.etaAt)) && text(row.reason, 500);
    case 'alloc.release':
      return validAllocId(row.id) && text(row.by, 200) && validUsage(row.usage);
    case 'alloc.reclaim':
      return validAllocId(row.id) && text(row.by, 200) && row.reason === 'ttl-expired';
    case 'alloc-budget-policy':
      return text(row.by, 200) && validAllocBudgetPolicy(row.policy);
    case 'alloc-reconcile':
      return text(row.by, 200) && typeof row.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.day) && Array.isArray(row.rows)
        && row.rows.every(r => isRec(r) && validAllocId(r.provider) && num(r.meteredUsd) && num(r.meteredTokens) && Number.isSafeInteger(r.grants)
          && (r.providerUsedPct === null || pct(r.providerUsedPct)) && (r.deltaUsedPct === null || typeof r.deltaUsedPct === 'number')
          && typeof r.alert === 'boolean' && text(r.why, 500));
    default:
      return false;
  }
}
