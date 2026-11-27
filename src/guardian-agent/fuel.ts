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

export interface FuelVerdict { readonly low: string[]; readonly exhausted: string[]; readonly floorGone: boolean; readonly stale: boolean; readonly value: string; readonly ok: boolean | null }
/** Pure: the 연료관 KPI from the account rows. */
export function judgeFuel(rows: readonly WorldEntry[]): FuelVerdict {
  const acc = rows.filter(e => e.kind === 'account');
  if (!acc.length) return { low: [], exhausted: [], floorGone: false, stale: false, value: '계정 잔량 스냅숏 없음 (eln usage status-cache)', ok: null };
  const low = acc.filter(e => e.status === 'low').map(e => e.id);
  const exhausted = acc.filter(e => e.status === 'exhausted').map(e => e.id);
  const floor = acc.filter(e => FLOOR_PROVIDERS.includes(String(e.facts.provider)));
  const floorGone = floor.length > 0 && floor.every(e => e.status === 'exhausted');
  const stale = acc.some(e => e.facts.stale === true);
  const pct = (e: WorldEntry) => (typeof e.facts.used === 'number' ? `${Math.round((e.facts.used as number) * 100)}%` : '?');
  return { low, exhausted, floorGone, stale,
    value: `${acc.map(e => `${e.id} ${pct(e)}`).join(' · ')}${stale ? ' (stale)' : ''}${floorGone ? ' · ⚠ floor gone' : ''}`,
    ok: !floorGone && exhausted.length === 0 };
}
