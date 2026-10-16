/**
 * /ceo flow strip parsing — lives outside page.tsx because a Next.js page module
 * may only export Page fields (default · metadata …); helpers exported there fail `next build`.
 */

/** Closed RFC A4 vocabulary — duplicated here so the client page does not import Node overview.ts. */
export const OVERVIEW_VERDICT_LABEL = {
  unobservable: '관측 불가',
  blocked: '막힘',
  'loop-down': '루프 정지',
  saturated: '자원 포화',
  'supply-empty': '공급 부족',
  degraded: '흐름 저하',
  flowing: '흐름 정상',
} as const;
export type OverviewVerdict = keyof typeof OVERVIEW_VERDICT_LABEL;
/** Snapshot memo TTL in overview-cache.ts; past this the strip marks 낡음. */
export const OVERVIEW_STALE_MS = 10_000;
export type FlowStrip = {
  verdict: OverviewVerdict;
  label: (typeof OVERVIEW_VERDICT_LABEL)[OverviewVerdict];
  reason: string | null;
  stale: boolean;
};

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Own-key check — `in` would accept inherited `constructor` / `toString`. */
export function parseOverviewStrip(body: unknown): FlowStrip | null {
  if (!object(body) || !Object.hasOwn(body, 'verdict') || !Object.hasOwn(body, 'reasons')) return null;
  const verdict = body.verdict;
  if (typeof verdict !== 'string' || !Object.hasOwn(OVERVIEW_VERDICT_LABEL, verdict)) return null;
  const reasons = body.reasons;
  if (!Array.isArray(reasons) || !reasons.every((row: unknown) => typeof row === 'string')) return null;
  const reason = reasons[0] ? reasons[0] : null;
  // The server always sends a non-negative cacheAgeMs; a missing or malformed age is 못 잼, not «fresh».
  const cacheAgeMs = Object.hasOwn(body, 'cacheAgeMs') ? body.cacheAgeMs : undefined;
  if (typeof cacheAgeMs !== 'number' || !Number.isFinite(cacheAgeMs) || cacheAgeMs < 0) return null;
  return {
    verdict: verdict as OverviewVerdict,
    label: OVERVIEW_VERDICT_LABEL[verdict as OverviewVerdict],
    reason,
    stale: cacheAgeMs >= OVERVIEW_STALE_MS,
  };
}
