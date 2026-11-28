// 수호자·연료관 (fuel) — LLM accounts as world rows (GUARDIAN-CHARTER-1127 §1 연료 · §4 ⑤ · FEDERATION-ORG-SYSTEM v2).
//
// S: 11-27 codex team/third ~95 %, glm weekly 100 % — hands kept getting models whose account was dry.
// C: the numbers already exist (`<state>/status/llm-usage.json`, written by `eln usage status-cache` · #40354), and
//    MODEL-BY-DIFFICULTY already steps a tier down past ACCOUNT_CAP (pickHandModel · liveUsedShare reads the same file);
//    nobody turned them into an alarm before exhaustion or noticed the snapshot going stale.
// A: every pulse folds the snapshot into account rows (LLM 0, a file read); the 연료관 sub-agent refreshes a stale snapshot
//    (one bounded `eln usage status-cache`), alerts OP at ≥ 90 % (before the 95 % cap reroutes new cells) and raises a red card
//    when the floor itself (glm / OpenRouter) is gone — then no tier is left to step down to.
import type { WorldEntry } from './world.js';
import { capOf } from '../kit/resource-facts/index.js';

export interface UsageAccount { readonly provider: string; readonly account: string; readonly usedPercent: number | null; readonly leftUsd?: number; readonly resetsIn?: string; readonly status: 'ok' | 'error' | 'unknown' }
export interface UsageSnapshot { readonly ts: number; readonly accounts: readonly UsageAccount[]; readonly error?: string }

// RESOURCE-FACTS-FROM-LEDGER: thresholds are resource facts (policy `caps.fuelLow` · `caps.accountCap`), read per pulse.
export const fuelLow = (): number => capOf('fuelLow');
export const fuelExhausted = (): number => capOf('accountCap'); // = MODEL-BY-DIFFICULTY accountCap() (new cells step a tier down here)
export const FUEL_STALE_MS = 10 * 60_000; // = LLM_USAGE_STALE_MS
/** The floor of the hand ladder (MODEL-BY-DIFFICULTY TIER_MODEL.easy = openrouter z-ai/glm) and its subscription twin. */
export const FLOOR_PROVIDERS = ['openrouter', 'zai'];

/** used share 0..1 (openrouter prepaid: balance gone = 1, else 0) — null = unknown */
export function usedShare(a: UsageAccount): number | null {
  if (a.status !== 'ok') return null;
  if (a.provider === 'openrouter') return typeof a.leftUsd === 'number' ? (a.leftUsd <= 0 ? 1 : 0) : null;
  return typeof a.usedPercent === 'number' ? a.usedPercent / 100 : null;
}

/** Pure: snapshot → world account rows. A stale snapshot keeps its numbers and says so. */
export function accountEntries(snap: UsageSnapshot | null, nowMs: number): WorldEntry[] {
  if (!snap) return [];
  const stale = nowMs - snap.ts > FUEL_STALE_MS;
  const seen = new Date(snap.ts).toISOString();
  return snap.accounts.map(a => {
    const used = usedShare(a);
    const status = a.status === 'error' ? 'unknown' : used === null ? 'unknown' : used >= fuelExhausted() ? 'exhausted' : used >= fuelLow() ? 'low' : 'ok';
    return { kind: 'account' as const, id: `${a.provider}:${a.account}`, owner: 'GUARDIAN', status, lastSeen: seen,
      facts: { provider: a.provider, used, ...(a.leftUsd !== undefined ? { leftUsd: a.leftUsd } : {}), ...(a.resetsIn ? { resetsIn: a.resetsIn } : {}), stale } };
  });
}

/** GUARDIAN-SUBS (11-28 07:5x «연료관 KPI miss 30× · 행동 없음»): the llm-accounts decision per usage account — an exhausted
 *  account it already took off the subscription route (level L3 · skip) is NORMALIZED (phase-set did it), not a miss. */
export interface FuelRoutes {
  readonly accounts: Readonly<Record<string, { readonly pack: string; readonly routed: boolean; readonly routable: boolean; readonly level: string }>>;
  /** pack provider → its effective SUBSCRIPTION route order (llm-decide `route` minus accounts on the credits path only) */
  readonly providers: Readonly<Record<string, readonly string[]>>;
}
/** Pure: stamp each account row with its route facts (`routed` · `routable` · `level` · `pack` · `handled`) — untouched when
 *  unknown. `handled` = the decision already reacted to the account's level (L1 demote · L2 demote ⊕ tier down · L3 skip):
 *  the guardian's 95 % «exhausted» (resource facts accountCap) sits below the pack cap (100 %), so a 96 % account is
 *  legitimately still routed — demoted and stepped a tier down (sim GRD-FUEL-7DAY found this, 11-28). */
export function annotateRoutes(rows: readonly WorldEntry[], routes: FuelRoutes | null): WorldEntry[] {
  if (!routes) return [...rows];
  return rows.map(e => { const r = routes.accounts[e.id]; return r ? { ...e, facts: { ...e.facts, routed: r.routed, routable: r.routable, level: r.level, pack: r.pack, handled: !r.routed || r.level !== 'L0' } } : e; });
}

export interface FuelVerdict {
  readonly low: string[]; readonly exhausted: string[];
  /** exhausted AND still on the subscription route (or route unknown) — the real miss (cells still sent to a dry account) */
  readonly stuck: string[];
  /** exhausted and already taken off the subscription route by the decision (normalized) */
  readonly skipped: string[];
  /** exhausted, still routed but demoted / a tier down by its level (normalized — the pack cap is above the guardian's) */
  readonly demoted: string[];
  /** pack providers with accounts but none routable (no subscription · no credits) — cells fall to the fallback chain */
  readonly dry: string[];
  readonly floorGone: boolean; readonly stale: boolean; readonly value: string;
}
/** Pure: the 연료관 summary of the account rows (the KPI's ok is the agent.yaml line — CODE-BODY-TO-KIND). */
export function judgeFuel(rows: readonly WorldEntry[]): FuelVerdict {
  const acc = rows.filter(e => e.kind === 'account');
  if (!acc.length) return { low: [], exhausted: [], stuck: [], skipped: [], demoted: [], dry: [], floorGone: false, stale: false, value: '계정 잔량 스냅숏 없음 (eln usage status-cache)' };
  const exhausted = acc.filter(e => e.status === 'exhausted').map(e => e.id);
  const skipped = acc.filter(e => e.status === 'exhausted' && e.facts.routed === false).map(e => e.id);
  const demoted = acc.filter(e => e.status === 'exhausted' && e.facts.routed === true && e.facts.handled === true).map(e => e.id);
  const stuck = exhausted.filter(id => !skipped.includes(id) && !demoted.includes(id));
  // a low account the decision already reacted to needs no warning either
  const low = acc.filter(e => e.status === 'low' && e.facts.handled !== true).map(e => e.id);
  const byPack = new Map<string, WorldEntry[]>();
  for (const e of acc) if (typeof e.facts.pack === 'string') byPack.set(e.facts.pack, [...(byPack.get(e.facts.pack) ?? []), e]);
  const dry = [...byPack].filter(([, es]) => es.every(e => e.facts.routable === false)).map(([p]) => p).sort();
  const floor = acc.filter(e => FLOOR_PROVIDERS.includes(String(e.facts.provider)));
  const floorGone = floor.length > 0 && floor.every(e => e.status === 'exhausted');
  const stale = acc.some(e => e.facts.stale === true);
  const pct = (e: WorldEntry) => (typeof e.facts.used === 'number' ? `${Math.round((e.facts.used as number) * 100)}%` : '?');
  const routed = acc.some(e => typeof e.facts.routed === 'boolean');
  const tag = (e: WorldEntry) => (e.status === 'ok' || e.status === 'unknown' ? '' : e.facts.routed === false ? ' 건너뜀' : e.facts.handled === true ? ' 강등' : '');
  return { low, exhausted, stuck, skipped, demoted, dry, floorGone, stale,
    value: `${acc.map(e => `${e.id} ${pct(e)}${tag(e)}`).join(' · ')}${stale ? ' (stale)' : ''}${floorGone ? ' · ⚠ floor gone' : ''}`
      + `${routed ? ` · 소진·경로 잔존 ${stuck.length}${stuck.length ? `(${stuck.join(',')})` : ''} · 건너뜀 ${skipped.length} · 강등 ${demoted.length}` : ''}${dry.length ? ` · 경로 가능 계정 0: ${dry.join(',')}` : ''}` };
}
