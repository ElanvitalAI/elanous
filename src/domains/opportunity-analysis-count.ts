/** Limit scheduled analysis work while keeping one-shot validation independent. */
export function opportunityAnalysisCount(candidates: number, opts: { armOnce: boolean; armed: boolean }): number {
  return opts.armOnce ? Math.min(1, candidates) : opts.armed ? Math.min(2, candidates) : 0;
}
