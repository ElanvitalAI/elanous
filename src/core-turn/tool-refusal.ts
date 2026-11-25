/** WAKE-CAP-RECLAIM — a tool result that says `success:false` (directly, or inside a host `{ ok, result }` envelope). */
export function isExplicitToolRefusal(result: unknown): boolean {
  if (result === null || typeof result !== 'object') return false;
  const r = result as { success?: unknown; result?: unknown };
  if (r.success === false) return true;
  const inner = r.result;
  return inner !== null && typeof inner === 'object' && (inner as { success?: unknown }).success === false;
}
