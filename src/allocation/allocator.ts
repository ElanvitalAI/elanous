// ALLOCATION-BUDGET allocator — one pure decision per request (CEO 11-27 11:0x «전체 밸런스를 보면서 누가 요청했는지, 어떻게
// 쓰는지 보고 LLM 과 머신을 할당»):
//   grant        within budget and capacity for this purpose (purpose ceilings leave reserve for P0 · cut)
//   step down    tight → the provider's stepDownTo (cheaper/other account) or the next host with room
//   queue        nothing fits → ETA (window refill · next KST day for paid caps · earliest host lease end)
//   override     P0 cell and release cut are never stalled: granted even past ceilings, with the reason as an alert
// «Balance»: when an account is scarce (≥ scarceAtPct), one identity may hold at most seatShareMaxPct of its last-24h use.
import type { AllocAmount, AllocBudgetPolicy, AllocGrantMode, AllocIdentity, AllocPurpose, AllocResource } from './alloc-events.js';
import { identityKey } from './identity.js';
import { budgetView, isHolding, providerOf, providerResetsIn, providerUsedPct, since, topConsumers, type AllocRow, type AllocUsageSnapshot } from './fold.js';
import { inCutWindow, isUrgent, kstDay, normalizeProvider } from './policy.js';

export interface AllocRequest { readonly who: AllocIdentity; readonly purpose: AllocPurpose; readonly resource: AllocResource; readonly amount: AllocAmount; readonly ttlMs: number }
export type AllocDecision =
  | { readonly status: 'granted'; readonly mode: AllocGrantMode; readonly resource: AllocResource; readonly reason: string; readonly alerts: string[] }
  | { readonly status: 'queued'; readonly etaAt: string | null; readonly reason: string; readonly alerts: string[] };

const BALANCE_MIN_SAMPLE = 3;
const round = (n: number) => Math.round(n * 10) / 10;

/** «3d 8h» · «2h 5m» · «12m» → ms (undefined when unparsable). */
export function parseResetsIn(s: string | undefined): number | undefined {
  if (!s) return undefined;
  let ms = 0; let hit = false;
  for (const m of s.matchAll(/(\d+)\s*([dhm])/g)) { hit = true; ms += Number(m[1]) * (m[2] === 'd' ? 86_400_000 : m[2] === 'h' ? 3_600_000 : 60_000); }
  return hit ? ms : undefined;
}
const nextKstMidnight = (now: Date) => new Date(Date.parse(`${kstDay(now)}T00:00:00+09:00`) + 86_400_000);

/** Why this provider cannot take the request now (null = it can). Also collects non-blocking alerts. */
function llmBlock(provider: string, req: AllocRequest, rows: readonly AllocRow[], policy: AllocBudgetPolicy, snap: AllocUsageSnapshot | null, now: Date, alerts: string[]): { reason: string; hard: boolean } | null {
  const conf: AllocBudgetPolicy['providers'][string] = policy.providers[provider] ?? {};
  const urgent = isUrgent(req.purpose.kind);
  const used = providerUsedPct(snap, provider);
  const cap = conf.windowCapPct ?? 100;
  const ceilPct = policy.purposeCeilingPct[req.purpose.kind] ?? 100;
  const reserve = !urgent && inCutWindow(policy, now) ? policy.cutWindow.reservePct : 0;
  const ceiling = round(cap * Math.max(0, ceilPct - reserve) / 100);
  if (used !== null && used >= cap) return { reason: `${provider} 창 ${round(used)}% ≥ 상한 ${cap}%`, hard: true };
  if (used !== null && used >= ceiling) return { reason: `${provider} 창 ${round(used)}% ≥ ${req.purpose.kind} 상한 ${ceiling}%${reserve ? ` (컷 창 예비 ${reserve}%)` : ''}`, hard: false };
  const view = budgetView(rows, policy, snap, now);
  const est = req.amount.usd ?? 0;
  const mineToday = view.rows.find(r => r.provider === provider)?.todayUsd ?? 0;
  if (conf.dailyUsd !== undefined && mineToday + est > conf.dailyUsd) return { reason: `${provider} 오늘 $${round(mineToday)} + $${round(est)} > 일 예산 $${conf.dailyUsd}`, hard: true };
  if (conf.paid && view.paidTodayUsd + est > policy.paidDailyCapUsd) return { reason: `유료 오늘 $${round(view.paidTodayUsd)} + $${round(est)} > 일 상한 $${policy.paidDailyCapUsd}`, hard: true };
  if (conf.dailyUsd !== undefined && (mineToday + est) / conf.dailyUsd * 100 >= policy.alertAtPct) alerts.push(`${provider} 오늘 $${round(mineToday + est)}/$${conf.dailyUsd} ≥ ${policy.alertAtPct}%`);
  if (conf.paid && (view.paidTodayUsd + est) / policy.paidDailyCapUsd * 100 >= policy.alertAtPct) alerts.push(`유료 오늘 $${round(view.paidTodayUsd + est)}/$${policy.paidDailyCapUsd} ≥ ${policy.alertAtPct}%`);
  if (used !== null && used >= policy.scarceAtPct && !urgent) {
    const recent = since(rows, now.getTime() - 24 * 3_600_000).filter(r => providerOf(r) === provider);
    if (recent.length >= BALANCE_MIN_SAMPLE) {
      const me = topConsumers(recent, policy).find(g => g.key === identityKey(req.who));
      if (me && me.share * 100 > policy.seatShareMaxPct) return { reason: `${identityKey(req.who)} 몫 ${Math.round(me.share * 100)}% > ${policy.seatShareMaxPct}% (희소 ${provider} ${round(used)}%)`, hard: false };
    }
  }
  return null;
}

function decideLlm(req: AllocRequest & { resource: Extract<AllocResource, { type: 'llm' }> }, rows: readonly AllocRow[], policy: AllocBudgetPolicy, snap: AllocUsageSnapshot | null, now: Date): AllocDecision {
  const alerts: string[] = [];
  const first = normalizeProvider(req.resource.provider);
  const block = llmBlock(first, req, rows, policy, snap, now, alerts);
  if (!block) return { status: 'granted', mode: 'granted', resource: req.resource, reason: 'within budget', alerts };
  const urgent = isUrgent(req.purpose.kind);
  // step down along stepDownTo (no cycles)
  const seen = new Set([first]);
  let next = policy.providers[first]?.stepDownTo;
  while (next && !seen.has(normalizeProvider(next))) {
    const p = normalizeProvider(next); seen.add(p);
    const sub: string[] = [];
    if (!llmBlock(p, req, rows, policy, snap, now, sub)) {
      return { status: 'granted', mode: 'stepped-down', resource: { type: 'llm', provider: p }, reason: `${block.reason} → ${p}`, alerts: [...alerts, ...sub] };
    }
    next = policy.providers[p]?.stepDownTo;
  }
  if (urgent) return { status: 'granted', mode: 'override', resource: req.resource, reason: `${req.purpose.kind} 은 멈추지 않는다 — ${block.reason}`, alerts: [...alerts, block.reason] };
  const resets = parseResetsIn(providerResetsIn(snap, first));
  const conf: AllocBudgetPolicy['providers'][string] = policy.providers[first] ?? {};
  const eta = resets !== undefined ? new Date(now.getTime() + resets)
    : conf.dailyUsd !== undefined || conf.paid ? nextKstMidnight(now) : new Date(now.getTime() + 3_600_000);
  return { status: 'queued', etaAt: eta.toISOString(), reason: block.reason, alerts };
}

function hostRoom(host: string, slots: number, req: AllocRequest, rows: readonly AllocRow[], policy: AllocBudgetPolicy, now: Date, full: boolean): { ok: boolean; inUse: number; cap: number | null; limit: number } {
  const cap = policy.hostSlots[host];
  const inUse = rows.filter(r => isHolding(r) && r.resource.type === 'host' && r.resource.host === host)
    .reduce((s, r) => s + (r.resource.type === 'host' ? r.resource.cpuSlots : 0), 0);
  if (cap === undefined) return { ok: true, inUse, cap: null, limit: Infinity };
  const ceilPct = full ? 100 : (policy.purposeCeilingPct[req.purpose.kind] ?? 100) - (!isUrgent(req.purpose.kind) && inCutWindow(policy, now) ? policy.cutWindow.reservePct : 0);
  const limit = Math.floor(cap * Math.max(0, ceilPct) / 100 + 1e-9);
  return { ok: inUse + slots <= limit, inUse, cap, limit };
}

function decideHost(req: AllocRequest & { resource: Extract<AllocResource, { type: 'host' }> }, rows: readonly AllocRow[], policy: AllocBudgetPolicy, now: Date): AllocDecision {
  const { host, cpuSlots } = req.resource;
  const urgent = isUrgent(req.purpose.kind);
  const here = hostRoom(host, cpuSlots, req, rows, policy, now, urgent);
  if (here.ok) return { status: 'granted', mode: 'granted', resource: req.resource, reason: here.cap === null ? `${host} 용량 미측정 — 기록만` : `${host} ${here.inUse + cpuSlots}/${here.limit} 슬롯`, alerts: [] };
  const why = `${host} ${here.inUse}+${cpuSlots} > ${here.limit} 슬롯 (${req.purpose.kind})`;
  for (const alt of policy.hostOrder) {
    if (alt === host || policy.hostSlots[alt] === undefined) continue;
    const r = hostRoom(alt, cpuSlots, req, rows, policy, now, urgent);
    if (r.ok) return { status: 'granted', mode: 'stepped-down', resource: { type: 'host', host: alt, cpuSlots }, reason: `${why} → ${alt}`, alerts: [] };
  }
  if (urgent) return { status: 'granted', mode: 'override', resource: req.resource, reason: `${req.purpose.kind} 은 멈추지 않는다 — ${why}`, alerts: [why] };
  const ends = rows.filter(r => isHolding(r) && r.resource.type === 'host' && r.resource.host === host && r.expiresAt).map(r => Date.parse(r.expiresAt!)).filter(t => t > now.getTime());
  return { status: 'queued', etaAt: ends.length ? new Date(Math.min(...ends)).toISOString() : null, reason: why, alerts: [] };
}

/** The allocator. Pure over (request, folded rows, policy, usage snapshot, now). */
export function decideAllocation(req: AllocRequest, rows: readonly AllocRow[], policy: AllocBudgetPolicy, snap: AllocUsageSnapshot | null, now: Date): AllocDecision {
  return req.resource.type === 'llm'
    ? decideLlm(req as AllocRequest & { resource: Extract<AllocResource, { type: 'llm' }> }, rows, policy, snap, now)
    : decideHost(req as AllocRequest & { resource: Extract<AllocResource, { type: 'host' }> }, rows, policy, now);
}
