// Pure planning only: the caller must persist and deliver cards atomically by key.
export interface StalePr { number: number; owner: string; open: boolean; updatedAt: number; receipt: boolean; dirty: boolean; red: boolean }
export interface CardReceipt { key: string; createdAt: number; respondedAt: number | null }
export interface ReapCard { key: string; to: string; pr: number; action: 'commit-push-pregate-or-return' | 'unanswered-owner' }
export function planStalePrCards(prs: StalePr[], receipts: CardReceipt[], now: number, thresholdMs: number): ReapCard[] {
  if (!Number.isFinite(now) || !Number.isFinite(thresholdMs) || thresholdMs <= 0) throw new Error('invalid clock or threshold');
  const seen = new Map(receipts.map(r => [r.key, r]));
  const result: ReapCard[] = [];
  for (const pr of prs) {
    if (!pr.open || pr.receipt || !(pr.dirty || pr.red) || !pr.owner || !Number.isFinite(pr.updatedAt) || now - pr.updatedAt < thresholdMs) continue;
    const ownerKey = `stale-pr:${pr.number}:owner`;
    const opKey = `stale-pr:${pr.number}:op`;
    const ownerCard = seen.get(ownerKey);
    if (!ownerCard) {
      result.push({key: ownerKey, to: pr.owner, pr: pr.number, action: 'commit-push-pregate-or-return'});
      seen.set(ownerKey, {key: ownerKey, createdAt: now, respondedAt: null});
    } else if (ownerCard.respondedAt == null && now - ownerCard.createdAt >= 24 * 3600_000 && !seen.has(opKey)) {
      result.push({key: opKey, to: 'OP', pr: pr.number, action: 'unanswered-owner'});
      seen.set(opKey, {key: opKey, createdAt: now, respondedAt: null});
    }
  }
  return result;
}
