const DAY_MS = 86_400_000;
const TERMINAL_STATUSES = new Set(['done', 'failed', 'disarmed', 'rejected', 'completed', 'cancelled']);

export function missionStaleness(
  updatedAtMs: number | undefined,
  nowMs: number,
  opts?: { thresholdDays?: number; timeZone?: string; status?: string },
): { stale: boolean; days: number; lastUpdated: string } | null {
  if (updatedAtMs === undefined || !Number.isFinite(updatedAtMs) || !Number.isFinite(nowMs)) return null;
  const updatedAt = new Date(updatedAtMs);
  if (!Number.isFinite(updatedAt.getTime())) return null;

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: opts?.timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(updatedAt);
  const part = (type: string) => parts.find((p) => p.type === type)?.value;
  const lastUpdated = `${part('year')}-${part('month')}-${part('day')}`;
  const days = Math.floor((nowMs - updatedAtMs) / DAY_MS);
  return {
    stale: !TERMINAL_STATUSES.has(opts?.status ?? '') && days >= (opts?.thresholdDays ?? 14),
    days,
    lastUpdated,
  };
}
