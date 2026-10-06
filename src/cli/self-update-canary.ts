export type EdgeRailDecision = 'hold' | 'canary-install' | 'promote-all' | 'rollback' | 'wait-quiet';
export interface EdgeRailPlan { decision: EdgeRailDecision; reason: string }
export interface EdgeRailInput {
  now: Date;
  mainCommit: string;
  installed: string;
  seat: string;
  canary: { seat: string; okRuns: number; startedAt: string } | null;
  failureRate: { before: number; after: number; samples: number } | null;
  quietWindow: boolean;
  canaryOkRuns?: number;
  failureMultiplier?: number;
  minSamples?: number;
  promoted?: boolean;
}

/** No I/O: unknown health, insufficient samples and unknown revision never trigger a cutover. */
export function planEdgeRail(input: EdgeRailInput): EdgeRailPlan {
  const { mainCommit, installed, seat, canary, failureRate, quietWindow } = input;
  const okRuns = input.canaryOkRuns ?? 3;
  const multiplier = input.failureMultiplier ?? 2;
  const minSamples = input.minSamples ?? 30;
  if (!Number.isFinite(input.now.getTime()) || !/^[a-f0-9]{12,40}$/i.test(mainCommit) || !/^[a-f0-9]{12,40}$/i.test(installed)
    || !Number.isSafeInteger(okRuns) || okRuns < 1 || !Number.isFinite(multiplier) || multiplier <= 1
    || !Number.isSafeInteger(minSamples) || minSamples < 1) return { decision: 'hold', reason: 'invalid or unknown rollout input' };
  const same = mainCommit.startsWith(installed) || installed.startsWith(mainCommit);
  if (canary && Date.parse(canary.startedAt) > input.now.getTime()) return { decision: 'hold', reason: 'canary started in the future' };
  if (canary && (canary.seat !== 'OP' || !Number.isSafeInteger(canary.okRuns) || canary.okRuns < 0
    || !Number.isFinite(Date.parse(canary.startedAt)))) return { decision: 'hold', reason: 'invalid canary state' };
  if (failureRate) {
    if (![failureRate.before, failureRate.after, failureRate.samples].every(Number.isFinite)
      || failureRate.before < 0 || failureRate.after < 0 || failureRate.before > 1 || failureRate.after > 1
      || !Number.isSafeInteger(failureRate.samples) || failureRate.samples < 0) return { decision: 'hold', reason: 'invalid failure-rate measurement' };
    if (failureRate.samples < minSamples) return { decision: 'hold', reason: `failure-rate samples ${failureRate.samples} < ${minSamples}` };
    if (same && canary && failureRate.after > 0 && failureRate.after >= failureRate.before * multiplier) return quietWindow
      ? { decision: 'rollback', reason: `failure rate ${failureRate.after} >= ${multiplier}x ${failureRate.before}` }
      : { decision: 'wait-quiet', reason: 'rollback requires quiet window for resident restart' };
  }
  if (canary && canary.okRuns < okRuns) return { decision: 'hold', reason: `OP canary ${canary.okRuns}/${okRuns} successful runs` };
  if (same) return { decision: 'hold', reason: 'installed commit already matches main' };
  if (input.promoted && canary && seat !== 'OP') return { decision: 'hold', reason: 'fleet promotion already completed' };
  if (!canary && seat !== 'OP') return { decision: 'hold', reason: 'OP canary has not installed' };
  if (!quietWindow) return { decision: 'wait-quiet', reason: 'resident restart requires quiet window' };
  if (!canary) return { decision: 'canary-install', reason: 'install OP canary first' };
  return { decision: 'promote-all', reason: `OP canary passed ${canary.okRuns}/${okRuns} successful runs` };
}
