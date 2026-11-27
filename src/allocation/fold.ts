// ALLOCATION-BUDGET — one fold of the alloc rows on the lease ledger into allocations, and the reports built on it
// (who · purpose · period · top · budget · KPI unattributed/unspecified). Pure: events in, rows/reports out.
import type { AllocAmount, AllocBudgetPolicy, AllocConsumer, AllocGrantMode, AllocIdentity, AllocLedgerEvent, AllocPurpose, AllocResource, AllocUsage } from './alloc-events.js';
import { identityKey } from './identity.js';
import { kstDay, normalizeProvider } from './policy.js';

export type AllocState = 'reserved' | 'active' | 'queued' | 'released' | 'reclaimed' | 'expired';
export interface AllocRow {
  readonly id: string; readonly who: AllocIdentity; readonly purpose: AllocPurpose; readonly consumer: AllocConsumer;
  readonly requested: AllocResource; resource: AllocResource; readonly amount: AllocAmount; readonly ttlMs: number; readonly reservedAt: string;
  grantedAt?: string; expiresAt?: string; mode?: AllocGrantMode; reason?: string; alerts: string[]; etaAt?: string | null;
  releasedAt?: string; reclaimedAt?: string; usage?: AllocUsage; state: AllocState; durationMs: number | null;
}

/** The usage snapshot shape (<state>/status/llm-usage.json · guardian fuel UsageSnapshot). */
export interface AllocUsageSnapshot { readonly ts: number; readonly accounts: readonly { readonly provider: string; readonly account: string; readonly usedPercent: number | null; readonly leftUsd?: number; readonly resetsIn?: string; readonly status: string }[] }

export function foldAllocations(events: readonly { event: string }[], now: Date): AllocRow[] {
  const rows = new Map<string, AllocRow>();
  const nowMs = now.getTime();
  for (const raw of events) {
    const e = raw as AllocLedgerEvent;
    if (e.event === 'alloc.reserve') {
      if (rows.has(e.id)) continue;
      rows.set(e.id, { id: e.id, who: e.who, purpose: e.purpose, consumer: e.consumer, requested: e.resource, resource: e.resource, amount: e.amount,
        ttlMs: e.ttlMs, reservedAt: e.at, alerts: [], state: 'reserved', durationMs: null });
      continue;
    }
    if (!('id' in e)) continue;
    const r = rows.get(e.id);
    if (!r) continue;
    if (e.event === 'alloc.grant' && (r.state === 'reserved' || r.state === 'queued')) {
      Object.assign(r, { grantedAt: e.at, expiresAt: e.expiresAt, mode: e.mode, reason: e.reason, alerts: e.alerts, resource: e.resource, state: 'active' });
    } else if (e.event === 'alloc.queue' && r.state === 'reserved') {
      Object.assign(r, { etaAt: e.etaAt, reason: e.reason, state: 'queued' });
    } else if (e.event === 'alloc.release' && (r.state === 'active' || r.state === 'queued' || r.state === 'reserved')) {
      Object.assign(r, { releasedAt: e.at, usage: e.usage, state: 'released', durationMs: Math.max(0, Date.parse(e.at) - Date.parse(r.grantedAt ?? r.reservedAt)) });
    } else if (e.event === 'alloc.reclaim' && r.state === 'active') {
      Object.assign(r, { reclaimedAt: e.at, state: 'reclaimed', durationMs: Math.max(0, Date.parse(e.at) - Date.parse(r.grantedAt ?? r.reservedAt)) });
    }
  }
  for (const r of rows.values()) if (r.state === 'active' && r.expiresAt && Date.parse(r.expiresAt) <= nowMs) r.state = 'expired';
  return [...rows.values()];
}

export const isHolding = (r: AllocRow): boolean => r.state === 'active' || r.state === 'expired';
export const providerOf = (r: AllocRow): string | null => r.resource.type === 'llm' ? normalizeProvider(r.resource.provider) : null;
export const tokensOf = (r: AllocRow): number => r.usage ? (r.usage.inputTokens ?? 0) + (r.usage.outputTokens ?? 0) : (r.amount.tokens ?? 0);
export const usdOf = (r: AllocRow): number => r.usage?.usd ?? (isHolding(r) ? r.amount.usd ?? 0 : 0);
export const paidUsdOf = (r: AllocRow, policy: AllocBudgetPolicy): number => {
  const p = providerOf(r);
  if (!p) return 0;
  if (r.usage?.billing === 'subscription') return 0;
  return r.usage?.billing === 'paid' || policy.providers[p]?.paid ? usdOf(r) : 0;
};
export const cpuMinOf = (r: AllocRow): number => r.usage?.cpuMin ?? (r.resource.type === 'host' && isHolding(r) ? r.amount.cpuMin ?? 0 : 0);
const atOf = (r: AllocRow) => r.grantedAt ?? r.reservedAt;
/** Spend lands on the day it was settled (release), an open estimate on the day it was granted. */
const spendAt = (r: AllocRow) => r.releasedAt ?? r.reclaimedAt ?? atOf(r);
/** A share weight: tokens if known, else $ × 100k, else 1 per allocation. */
const weightOf = (r: AllocRow) => tokensOf(r) || usdOf(r) * 100_000 || cpuMinOf(r) || 1;

export const since = (rows: readonly AllocRow[], sinceMs: number): AllocRow[] => rows.filter(r => Date.parse(atOf(r)) >= sinceMs);

export interface AllocGroup { readonly key: string; grants: number; holding: number; queued: number; tokens: number; usd: number; paidUsd: number; cpuMin: number; durationMs: number; weight: number; share: number; chain?: string }
function group(rows: readonly AllocRow[], keyOf: (r: AllocRow) => string, policy: AllocBudgetPolicy): AllocGroup[] {
  const m = new Map<string, AllocGroup>();
  let total = 0;
  for (const r of rows) {
    const k = keyOf(r);
    const g = m.get(k) ?? { key: k, grants: 0, holding: 0, queued: 0, tokens: 0, usd: 0, paidUsd: 0, cpuMin: 0, durationMs: 0, weight: 0, share: 0 };
    g.grants++; if (isHolding(r)) g.holding++; if (r.state === 'queued') g.queued++;
    g.tokens += tokensOf(r); g.usd += usdOf(r); g.paidUsd += paidUsdOf(r, policy); g.cpuMin += cpuMinOf(r); g.durationMs += r.durationMs ?? 0;
    const w = weightOf(r); g.weight += w; total += w;
    if (!g.chain && r.who.chain.length > 1) g.chain = r.who.chain.map(l => `${l.kind}:${l.id}`).join(' → ');
    m.set(k, g);
  }
  for (const g of m.values()) g.share = total ? g.weight / total : 0;
  return [...m.values()].sort((a, b) => b.weight - a.weight || a.key.localeCompare(b.key));
}
export const byWho = (rows: readonly AllocRow[], policy: AllocBudgetPolicy) => group(rows, r => identityKey(r.who), policy);
export const byPurpose = (rows: readonly AllocRow[], policy: AllocBudgetPolicy) => group(rows, r => r.purpose.kind, policy);
export const byResource = (rows: readonly AllocRow[], policy: AllocBudgetPolicy) =>
  group(rows, r => r.resource.type === 'llm' ? `llm:${normalizeProvider(r.resource.provider)}` : `host:${r.resource.host}`, policy);
export function byPeriod(rows: readonly AllocRow[], unit: 'hour' | 'day', policy: AllocBudgetPolicy): AllocGroup[] {
  const key = (r: AllocRow) => { const k = new Date(Date.parse(atOf(r)) + 9 * 3_600_000).toISOString(); return unit === 'day' ? k.slice(0, 10) : `${k.slice(0, 13)}h`; };
  return group(rows, key, policy).sort((a, b) => a.key.localeCompare(b.key));
}
/** Shares of one scarce provider (or all) per identity. */
export const topConsumers = (rows: readonly AllocRow[], policy: AllocBudgetPolicy, provider?: string) =>
  byWho(provider ? rows.filter(r => providerOf(r) === normalizeProvider(provider)) : rows, policy);

/** Metering KPI (target 0 %): unattributed identity · unspecified purpose · by count and by weight. */
export function meteringKpi(rows: readonly AllocRow[]): { total: number; unattributed: number; unspecified: number; unattributedShare: number; unspecifiedShare: number } {
  const total = rows.length;
  const unattributed = rows.filter(r => r.who.kind === 'unattributed').length;
  const unspecified = rows.filter(r => r.purpose.kind === 'unspecified').length;
  return { total, unattributed, unspecified, unattributedShare: total ? unattributed / total : 0, unspecifiedShare: total ? unspecified / total : 0 };
}

/** Subscription window used % for a provider: the best account (zai = its fullest window); null = unknown. */
export function providerUsedPct(snap: AllocUsageSnapshot | null, provider: string): number | null {
  const p = normalizeProvider(provider);
  const ok = (snap?.accounts ?? []).filter(a => normalizeProvider(a.provider) === p && a.status === 'ok');
  if (p === 'openrouter') return ok.length ? (ok.some(a => (a.leftUsd ?? 1) > 0) ? 0 : 100) : null;
  const used = ok.map(a => a.usedPercent).filter((u): u is number => typeof u === 'number');
  if (!used.length) return null;
  return p === 'zai' ? Math.max(...used) : Math.min(...used);
}
export const providerResetsIn = (snap: AllocUsageSnapshot | null, provider: string): string | undefined =>
  (snap?.accounts ?? []).find(a => normalizeProvider(a.provider) === normalizeProvider(provider) && a.resetsIn)?.resetsIn;
export const openRouterBalance = (snap: AllocUsageSnapshot | null): number | null =>
  (snap?.accounts ?? []).find(a => normalizeProvider(a.provider) === 'openrouter' && typeof a.leftUsd === 'number')?.leftUsd ?? null;

export interface BudgetRow {
  readonly provider: string; readonly usedPct: number | null; readonly capPct: number | null; readonly todayUsd: number; readonly dailyUsd: number | null;
  readonly burnUsdPerHour: number; readonly hoursToDailyCap: number | null; readonly holding: number; readonly alert: string | null; readonly resetsIn?: string;
}
export interface BudgetView { readonly day: string; readonly rows: BudgetRow[]; readonly paidTodayUsd: number; readonly paidDailyCapUsd: number; readonly paidAlert: string | null; readonly openRouterBalanceUsd: number | null; readonly policySource: string }

/** Burn rate vs budget and forecast to exhaustion (today's paid $ against the daily cap · the window share against its cap). */
export function budgetView(rows: readonly AllocRow[], policy: AllocBudgetPolicy & { source?: string }, snap: AllocUsageSnapshot | null, now: Date): BudgetView {
  const day = kstDay(now);
  const today = rows.filter(r => kstDay(new Date(Date.parse(spendAt(r)))) === day);
  const last3h = rows.filter(r => Date.parse(spendAt(r)) >= now.getTime() - 3 * 3_600_000);
  const providers = [...new Set([...Object.keys(policy.providers), ...rows.map(providerOf).filter((p): p is string => !!p)])].sort();
  const pct = (a: number, b: number) => (b > 0 ? (a / b) * 100 : 0);
  const out = providers.map((provider): BudgetRow => {
    const conf: AllocBudgetPolicy['providers'][string] = policy.providers[provider] ?? {};
    const mine = (rs: readonly AllocRow[]) => rs.filter(r => providerOf(r) === provider);
    const todayUsd = mine(today).reduce((s, r) => s + usdOf(r), 0);
    const burn = mine(last3h).reduce((s, r) => s + usdOf(r), 0) / 3;
    const dailyUsd = conf.dailyUsd ?? null;
    const usedPct = providerUsedPct(snap, provider);
    const capPct = conf.windowCapPct ?? null;
    const hoursToDailyCap = dailyUsd !== null && burn > 0 ? Math.max(0, (dailyUsd - todayUsd) / burn) : null;
    const alert = dailyUsd !== null && pct(todayUsd, dailyUsd) >= policy.alertAtPct ? `${provider} 오늘 $${todayUsd.toFixed(2)}/$${dailyUsd} (≥${policy.alertAtPct}%)`
      : usedPct !== null && capPct !== null && usedPct >= capPct ? `${provider} 창 ${Math.round(usedPct)}% ≥ 상한 ${capPct}%`
      : usedPct !== null && usedPct >= policy.scarceAtPct ? `${provider} 창 ${Math.round(usedPct)}% (희소)` : null;
    const resetsIn = providerResetsIn(snap, provider);
    return { provider, usedPct, capPct, todayUsd, dailyUsd, burnUsdPerHour: burn, hoursToDailyCap, holding: mine(rows).filter(isHolding).length, alert, ...(resetsIn ? { resetsIn } : {}) };
  });
  const paidTodayUsd = today.reduce((s, r) => s + paidUsdOf(r, policy), 0);
  const paidAlert = pct(paidTodayUsd, policy.paidDailyCapUsd) >= policy.alertAtPct ? `유료 오늘 $${paidTodayUsd.toFixed(2)}/$${policy.paidDailyCapUsd} (≥${policy.alertAtPct}%)` : null;
  return { day, rows: out, paidTodayUsd, paidDailyCapUsd: policy.paidDailyCapUsd, paidAlert, openRouterBalanceUsd: openRouterBalance(snap), policySource: policy.source ?? 'default' };
}

/** One line for the OP pulse / fed snapshot: «예산: codex 68% · openrouter $893 (오늘 $12/$50) · 상위 소비 seat:TC 22% · 미귀속 0%». */
export function allocSummaryLine(rows: readonly AllocRow[], policy: AllocBudgetPolicy & { source?: string }, snap: AllocUsageSnapshot | null, now: Date): string {
  const b = budgetView(rows, policy, snap, now);
  const parts = b.rows.filter(r => r.usedPct !== null || r.todayUsd > 0).map(r => r.provider === 'openrouter' || r.dailyUsd !== null
    ? `${r.provider}${r.provider === 'openrouter' && b.openRouterBalanceUsd !== null ? ` $${Math.round(b.openRouterBalanceUsd)}` : ''} (오늘 $${r.todayUsd.toFixed(0)}${r.dailyUsd !== null ? `/$${r.dailyUsd}` : ''})`
    : `${r.provider} ${Math.round(r.usedPct!)}%`);
  const day = since(rows, now.getTime() - 24 * 3_600_000);
  const top = byWho(day, policy)[0];
  const kpi = meteringKpi(day);
  return `예산: ${parts.length ? parts.join(' · ') : '스냅숏 없음'}${top ? ` · 상위 소비 ${top.key} ${Math.round(top.share * 100)}%` : ''} · 미귀속 ${Math.round(kpi.unattributedShare * 100)}% · 목적 미상 ${Math.round(kpi.unspecifiedShare * 100)}%${b.paidAlert ? ` · ⚠ ${b.paidAlert}` : ''}`;
}
