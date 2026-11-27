// RESOURCE-FACTS resolver — world registry (lease ledger) ⊕ policy file ⊕ code defaults, cached for a short TTL.
// Never throws: a missing/corrupt ledger or policy file falls through to the next layer with a warning (logs.db).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { elanousStateRoot } from '../../autopilot/state-paths.js';
import { debug } from '../../debug/log.js';
import { DEFAULT_ACCOUNT_NAMES, DEFAULT_CAPS, DEFAULT_EXPIRIES, DEFAULT_HOSTS, DEFAULT_RETRY_HOSTS, DEFAULT_REVIEW, DEFAULT_LLM, DEFAULT_WARM_POOL_QUOTAS } from './defaults.js';
import { HOST_HEALTH, HOST_ROLES, type Caps, type FactSource, type HostFact, type HostHealth, type HostRole, type LlmAccountFact, type LlmRouteFact, type LlmRouting, type LlmUseFact, type PolicyFile, type ResourceFacts, type ReviewPolicy } from './types.js';

export const FACTS_TTL_MS = 30_000;

/** `<state>/resource-facts/policy.json` — OP · RES · guardian edit it (env RESOURCE_FACTS_POLICY overrides the path). */
export function policyPath(): string {
  return process.env.RESOURCE_FACTS_POLICY?.trim() || join(elanousStateRoot(), 'resource-facts', 'policy.json');
}

/** Minimal view of a folded world actor (world-registry.ts WorldActor) — only what facts need. */
export interface ActorLike {
  readonly id: string;
  readonly kind: string;
  readonly host: string | null;
  readonly declaredState: string;
  readonly state: string;
  readonly reason: string | null;
  readonly meta: Record<string, unknown>;
}

export interface ResolveInput {
  /** Folded world actors, or null when the ledger could not be read. */
  readonly actors: readonly ActorLike[] | null;
  /** Parsed policy file, or null when absent/invalid. */
  readonly policy: PolicyFile | null;
  readonly warnings?: readonly string[];
  readonly now?: Date;
}

const isRole = (v: unknown): v is HostRole => typeof v === 'string' && (HOST_ROLES as readonly string[]).includes(v);
const isHealth = (v: unknown): v is HostHealth => typeof v === 'string' && (HOST_HEALTH as readonly string[]).includes(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strList = (v: unknown): string[] | null => (Array.isArray(v) && v.every(x => typeof x === 'string') ? v as string[] : null);

/** Exclusion strength: the stronger state of two layers wins. */
const HEALTH_RANK: Readonly<Record<HostHealth, number>> = { unknown: 0, healthy: 1, reserved: 2, unhealthy: 3 };

/** Caps ending in `Percent` are 0..100; every other cap is a share 0..1 (exclusive of 0). */
export function capInRange(key: string, v: unknown): v is number {
  const n = num(v);
  if (n === null) return false;
  return /Percent$/u.test(key) ? n >= 0 && n <= 100 : n > 0 && n <= 1;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Pure: drop the malformed parts of a policy file (one bad entry never discards the rest — nor the ledger). */
export function sanitizePolicy(raw: PolicyFile | null, warnings: string[]): PolicyFile {
  if (!raw) return {};
  const out: Record<string, unknown> = {};
  if (raw.hosts !== undefined) {
    if (!isObj(raw.hosts)) warnings.push('policy hosts is not an object — ignored');
    else {
      const hosts: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(raw.hosts)) { if (isObj(v)) hosts[k] = v; else warnings.push(`policy hosts.${k} is not an object — ignored`); }
      out.hosts = hosts;
    }
  }
  for (const key of ['accountNames', 'review', 'llm', 'caps', 'expiries', 'creditAccounts', 'warmPoolQuotas'] as const) {
    const v = (raw as Record<string, unknown>)[key];
    if (v === undefined) continue;
    if (isObj(v)) out[key] = v; else warnings.push(`policy ${key} is not an object — ignored`);
  }
  if (raw.retryHosts !== undefined) out.retryHosts = raw.retryHosts;
  return out as PolicyFile;
}

type MutableHost = { -readonly [K in keyof HostFact]: HostFact[K] };

/** Pure: the three layers → facts. */
export function resolveFacts(input: ResolveInput): ResourceFacts {
  const warnings = [...(input.warnings ?? [])];
  const sources = new Set<FactSource>();
  const defaultsUsed: string[] = [];
  const pol = sanitizePolicy(input.policy, warnings);

  // ── hosts ──
  const hosts = new Map<string, MutableHost>();
  const polHosts = pol.hosts ?? {};
  const ledgerHosts = (input.actors ?? []).filter(a => a.kind === 'host' || a.kind === 'vm');
  const haveOwned = Object.keys(polHosts).length > 0 || ledgerHosts.some(a => Array.isArray(a.meta.roles));
  if (!haveOwned) defaultsUsed.push('hosts');
  for (const d of DEFAULT_HOSTS) {
    // Defaults seed every known host; a host owned by policy/ledger overwrites the fields it states.
    hosts.set(d.host, { ...d, ncpu: d.ncpu ?? null, note: null, source: 'default' });
  }
  const policyHealth = new Map<string, { health: HostHealth; note: string | null }>();
  for (const [name, p] of Object.entries(polHosts)) {
    if (isHealth(p.health)) policyHealth.set(name, { health: p.health, note: typeof p.note === 'string' ? p.note : null });
    const prev = hosts.get(name) ?? { host: name, roles: [], paid: false, paidApproved: false, hq: false, health: 'unknown' as HostHealth, priority: 50, ncpu: null, note: null, source: 'policy' as FactSource };
    const roles = strList(p.roles)?.filter(isRole);
    hosts.set(name, {
      ...prev,
      ...(roles ? { roles } : {}),
      ...(typeof p.paid === 'boolean' ? { paid: p.paid } : {}),
      ...(typeof p.paidApproved === 'boolean' ? { paidApproved: p.paidApproved } : {}),
      ...(typeof p.hq === 'boolean' ? { hq: p.hq } : {}),
      ...(isHealth(p.health) ? { health: p.health } : {}),
      ...(num(p.priority) !== null ? { priority: num(p.priority)! } : {}),
      ...(num(p.ncpu) !== null ? { ncpu: num(p.ncpu) } : {}),
      ...(typeof p.note === 'string' ? { note: p.note } : {}),
      source: 'policy',
    });
    sources.add('policy');
  }
  for (const a of ledgerHosts) {
    const name = a.host ?? a.id.replace(/^(host|vm):/u, '');
    if (!name) continue;
    const prev = hosts.get(name) ?? { host: name, roles: [], paid: a.kind === 'vm', paidApproved: false, hq: false, health: 'unknown' as HostHealth, priority: 50, ncpu: null, note: null, source: 'ledger' as FactSource };
    const m = a.meta;
    const roles = strList(m.roles)?.filter(isRole);
    let health: HostHealth = isHealth(m.health) ? m.health : prev.health;
    let note = typeof m.healthNote === 'string' ? m.healthNote : prev.note;
    // An exclusion stated by either layer holds: a policy reservation is not lifted by a ledger «healthy» (and vice versa).
    const pol = policyHealth.get(name);
    if (pol && HEALTH_RANK[pol.health] > HEALTH_RANK[health]) { health = pol.health; note = pol.note ?? note; }
    // An owner declaring the host off takes it out of routing — no code change (the CEO's «disappear from every caller»).
    if (a.declaredState === 'off') { health = 'unhealthy'; note = a.reason ?? 'declared off in the world registry'; }
    hosts.set(name, {
      ...prev,
      ...(roles ? { roles } : {}),
      ...(typeof m.paid === 'boolean' ? { paid: m.paid } : {}),
      ...(typeof m.paidApproved === 'boolean' ? { paidApproved: m.paidApproved } : {}),
      ...(typeof m.hq === 'boolean' ? { hq: m.hq } : {}),
      ...(num(m.priority) !== null ? { priority: num(m.priority)! } : {}),
      ...(num(m.ncpu) !== null ? { ncpu: num(m.ncpu) } : {}),
      health, note, source: 'ledger',
    });
    sources.add('ledger');
  }

  // ── LLM accounts (연료관 rows: `llm-account` kind, meta.usedPercent) ──
  const accounts: LlmAccountFact[] = [];
  for (const a of input.actors ?? []) {
    if (a.kind !== 'llm-account') continue;
    const id = a.id.replace(/^llm-account:/u, '');
    const [provider, account] = id.includes(':') ? [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)] : [String(a.meta.provider ?? id), String(a.meta.account ?? 'default')];
    accounts.push({ id: `${provider}:${account}`, provider: provider!, account: account!, usedPercent: num(a.meta.usedPercent), source: 'ledger' });
  }
  const accountNames: Record<string, readonly string[]> = { ...DEFAULT_ACCOUNT_NAMES };
  if (!pol.accountNames && accounts.length === 0) defaultsUsed.push('accountNames');
  for (const [p, names] of Object.entries(pol.accountNames ?? {})) { const l = strList(names); if (l) accountNames[p] = l; }
  for (const acc of accounts) {
    const cur = accountNames[acc.provider] ?? [];
    if (!cur.includes(acc.account)) accountNames[acc.provider] = [...cur, acc.account];
  }

  // ── review policy ──
  const pr = pol.review ?? {};
  if (!pol.review) defaultsUsed.push('review');
  const review: ReviewPolicy = {
    primary: typeof pr.primary === 'string' && pr.primary ? pr.primary : DEFAULT_REVIEW.primary,
    fallback: pr.fallback === null ? null : typeof pr.fallback === 'string' && pr.fallback ? pr.fallback : DEFAULT_REVIEW.fallback,
    fallbackAfterFailures: num(pr.fallbackAfterFailures) ?? DEFAULT_REVIEW.fallbackAfterFailures,
    fallbackMaxUsedPercent: num(pr.fallbackMaxUsedPercent) ?? DEFAULT_REVIEW.fallbackMaxUsedPercent,
    forbidden: strList(pr.forbidden) ?? DEFAULT_REVIEW.forbidden,
    also: strList(pr.also) ?? DEFAULT_REVIEW.also,
    fallbackWhenPrimaryUnavailable: typeof pr.fallbackWhenPrimaryUnavailable === 'boolean' ? pr.fallbackWhenPrimaryUnavailable : DEFAULT_REVIEW.fallbackWhenPrimaryUnavailable,
  };

  // ── LLM routing (routes × uses · LLM-ROUTE-ONE-SOURCE) ──
  const pl = pol.llm ?? {};
  if (!pol.llm) defaultsUsed.push('llm');
  const isRoute = (r: unknown): r is LlmRouteFact => !!r && typeof r === 'object' && typeof (r as LlmRouteFact).provider === 'string' && typeof (r as LlmRouteFact).model === 'string'
    && typeof (r as LlmRouteFact).engine === 'string' && strList((r as LlmRouteFact).accounts) !== null && ['subscription', 'credits', 'paid'].includes((r as LlmRouteFact).cost);
  const routes: Record<string, LlmRouteFact> = { ...DEFAULT_LLM.routes };
  for (const [k, r] of Object.entries(pl.routes ?? {})) { if (isRoute(r)) routes[k] = r; else warnings.push(`policy llm.routes.${k} is not a route — default kept`); }
  const uses: Record<string, LlmUseFact> = { ...DEFAULT_LLM.uses };
  for (const [k, u] of Object.entries(pl.uses ?? {})) { if (u && strList(u.order)) uses[k] = u; else warnings.push(`policy llm.uses.${k} has no order — default kept`); }
  const llm: LlmRouting = { routes, uses, alarmTo: typeof pl.alarmTo === 'string' && pl.alarmTo ? pl.alarmTo : DEFAULT_LLM.alarmTo };

  // ── caps · expiries · retry hosts ──
  if (!pol.caps) defaultsUsed.push('caps');
  const caps: Record<string, number> = { ...DEFAULT_CAPS };
  for (const [k, v] of Object.entries(pol.caps ?? {})) {
    if (capInRange(k, v)) caps[k] = v;
    else warnings.push(`policy caps.${k}=${JSON.stringify(v)} out of range (${/Percent$/u.test(k) ? '0..100' : '0..1'}) — default kept`);
  }
  if (!pol.expiries) defaultsUsed.push('expiries');
  const expiries: Record<string, string> = { ...DEFAULT_EXPIRIES };
  for (const [k, v] of Object.entries(pol.expiries ?? {})) { if (typeof v === 'string' && Number.isFinite(Date.parse(v))) expiries[k] = v; else warnings.push(`policy expiries.${k} is not a date — default kept`); }
  const retry = strList(pol.retryHosts);
  if (!retry) defaultsUsed.push('retryHosts');
  // CODEX-CREDIT-ACCOUNTS — no default on purpose (absent = unrestricted, the old behavior); a malformed list is dropped.
  const creditAccounts: Record<string, readonly string[]> = {};
  for (const [p, names] of Object.entries(pol.creditAccounts ?? {})) {
    const l = strList(names);
    if (l) creditAccounts[p] = l.map(n => n.trim()).filter(Boolean);
    else warnings.push(`policy creditAccounts.${p} is not a string list — ignored`);
  }

  if (defaultsUsed.length) { sources.add('default'); warnings.push(`default used: ${defaultsUsed.join(' · ')}`); }
  return {
    hosts: [...hosts.values()].sort((x, y) => x.priority - y.priority || x.host.localeCompare(y.host)),
    warmPoolQuotas: Object.fromEntries(Object.keys(DEFAULT_WARM_POOL_QUOTAS).map(host => [host, {
      ...DEFAULT_WARM_POOL_QUOTAS[host], ...pol.warmPoolQuotas?.[host],
    }])),
    accounts, accountNames, review, llm, caps: caps as Caps, expiries,
    retryHosts: retry ?? DEFAULT_RETRY_HOSTS,
    creditAccounts,
    resolvedAt: (input.now ?? new Date()).toISOString(),
    sources: [...sources], warnings,
  };
}

// ── live reads (never throw) ──

export interface ReadOptions { readonly policyFile?: string; readonly ledgerPath?: string; readonly now?: Date }

export function readPolicyFile(path = policyPath()): { policy: PolicyFile | null; warning: string | null } {
  try {
    if (!existsSync(path)) return { policy: null, warning: null };
    const j = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!j || typeof j !== 'object' || Array.isArray(j)) return { policy: null, warning: `policy ${path} is not an object — ignored` };
    return { policy: j as PolicyFile, warning: null };
  } catch (e) {
    return { policy: null, warning: `policy ${path} unreadable (${(e as Error).message.slice(0, 80)}) — ignored` };
  }
}

export function readWorldActors(ledgerPath?: string, now = new Date()): { actors: ActorLike[] | null; warning: string | null } {
  try {
    const r = require('../../resource-ledger/resource-ledger.js') as typeof import('../../resource-ledger/resource-ledger.js');
    const w = require('../../resource-ledger/world-registry.js') as typeof import('../../resource-ledger/world-registry.js');
    const path = ledgerPath ?? (process.env.RESOURCE_FACTS_LEDGER?.trim() || r.resourceLedgerPath());
    if (!existsSync(path)) return { actors: null, warning: `world ledger missing (${path})` };
    return { actors: w.foldWorld(r.readResourceLedger(path), now).actors, warning: null };
  } catch (e) {
    return { actors: null, warning: `world ledger unreadable (${(e as Error).message.slice(0, 80)})` };
  }
}

let cache: { key: string; at: number; facts: ResourceFacts } | null = null;
const warned = new Set<string>();

/** The facts now (cached FACTS_TTL_MS per policy/ledger path). Never throws. */
export function resourceFacts(opts: ReadOptions = {}): ResourceFacts {
  const now = opts.now ?? new Date();
  const pfile = opts.policyFile ?? policyPath();
  const key = `${pfile}|${opts.ledgerPath ?? process.env.RESOURCE_FACTS_LEDGER ?? ''}`;
  if (cache && cache.key === key && now.getTime() - cache.at < FACTS_TTL_MS && now.getTime() >= cache.at) return cache.facts;
  let facts: ResourceFacts;
  try {
    const p = readPolicyFile(pfile);
    const w = readWorldActors(opts.ledgerPath, now);
    facts = resolveFacts({ actors: w.actors, policy: p.policy, warnings: [p.warning, w.warning].filter((x): x is string => !!x), now });
  } catch (e) {
    facts = resolveFacts({ actors: null, policy: null, warnings: [`resolver failed (${(e as Error).message.slice(0, 80)})`], now });
  }
  for (const msg of facts.warnings) {
    if (warned.has(msg)) continue;
    warned.add(msg);
    try { debug.log('resource-facts', 'fallback', { warning: msg, policy: pfile }, { level: 'warn' }); } catch { /* observation must not break callers */ }
  }
  cache = { key, at: now.getTime(), facts };
  return facts;
}

/** Tests / sims: drop the cache (and the once-per-message warning memory). */
export function resetResourceFactsCache(): void { cache = null; warned.clear(); }

/** One named expiry as epoch ms (NaN when unknown). */
export function expiryOf(name: string, facts: ResourceFacts = resourceFacts()): number {
  const v = facts.expiries[name];
  return v ? Date.parse(v) : Number.NaN;
}

/** One cap/threshold. */
export function capOf<K extends keyof Caps & string>(name: K, facts: ResourceFacts = resourceFacts()): number {
  return facts.caps[name] ?? DEFAULT_CAPS[name] ?? Number.NaN;
}

/** Does a responding model id count as a review under the policy? `role` = which slot it filled. */
export function acceptReviewModel(model: string, policy: ReviewPolicy = resourceFacts().review): { ok: boolean; role: 'primary' | 'fallback' | null; why: string } {
  const m = model.toLowerCase();
  if (!m) return { ok: false, role: null, why: 'no model recorded' };
  if (policy.forbidden.some(f => m.includes(f.toLowerCase()))) return { ok: false, role: null, why: `${model} is a forbidden reviewer` };
  if (m.includes(policy.primary.toLowerCase())) return { ok: true, role: 'primary', why: `${model} = primary reviewer` };
  const also = (policy.also ?? []).find(f => m.includes(f.toLowerCase()));
  if (also) return { ok: true, role: 'primary', why: `${model} = reviewer (${also} · asked between primary and fallback)` };
  if (policy.fallback && m.includes(policy.fallback.toLowerCase())) return { ok: true, role: 'fallback', why: `${model} = fallback reviewer (reviewer=${policy.fallback}(fallback))` };
  return { ok: false, role: null, why: `${model} is neither primary (${policy.primary}) nor fallback (${policy.fallback ?? '-'})` };
}
