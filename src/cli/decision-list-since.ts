/** Shared with the full CLI to keep `decisions list --since` parsing identical. */
export function decisionListSince(raw?: string): string | undefined {
  if (!raw) return undefined;
  const days = /^(\d+)d$/.exec(raw);
  const parsed = days ? new Date(Date.now() - Number(days[1]) * 86400000) : new Date(raw);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`invalid since: ${raw}`);
  return parsed.toISOString();
}

/** Reapply the moving cutoff after a cache hit keyed by the stable raw filter. */
export function filterDecisionListSince<T extends { raisedAt?: string }>(rows: readonly T[], since?: string): T[] {
  return since ? rows.filter(row => row.raisedAt !== undefined && row.raisedAt >= since) : [...rows];
}
