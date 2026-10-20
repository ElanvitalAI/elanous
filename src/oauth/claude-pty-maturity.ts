import { debug } from '../debug/log.js';
import { classifyLedgerRun, queryUsageOutcomes, type UsageOutcomesDeps } from '../budget/usage-outcomes.js';
import { loadRunLedger } from '../self-implement/run-ledger.js';

export type ClaudePtyMaturity =
  | { readonly mature: true }
  | { readonly mature: false; readonly why: 'too-few-samples' | 'completion-below-70' | 'unknown-screen-above-10' | 'intervention-above-0.2' | 'sample-unreadable' };

export type ClaudePtyMaturitySample = {
  readonly runCount: number;
  readonly completedCount: number;
  readonly unknownScreenCount: number;
  readonly interventionCount: number;
};

/** Read the latest Claude PTY runs from the run ledger without changing the ledger or fallback path. */
export function collectClaudePtyMaturitySample(
  deps: UsageOutcomesDeps & { readonly limit?: number },
): ClaudePtyMaturitySample | null {
  const limit = deps.limit ?? 10;
  const nowMs = deps.nowMs ?? Date.now();
  let runCount = 0;
  let completedCount = 0;
  let readable = Number.isSafeInteger(limit) && limit > 0;
  let sample: ClaudePtyMaturitySample | null = null;

  if (readable) {
    const ledgers: { readonly runId: string; readonly entries: NonNullable<ReturnType<NonNullable<UsageOutcomesDeps['load']>>> }[] = [];
    const load = deps.load ?? loadRunLedger;
    try {
      // The maturity sample is over the latest runs, not over a recent time window.
      // Number.MAX_SAFE_INTEGER days covers the full JavaScript Date range.
      const report = queryUsageOutcomes(Number.MAX_SAFE_INTEGER, {
        ...deps,
        load: (runId, dir, read) => {
          const entries = load(runId, dir, read);
          if (entries) ledgers.push({ runId, entries });
          return entries;
        },
      });
      const runs = ledgers.flatMap(({ runId, entries }) => {
        const classified = classifyLedgerRun(entries, nowMs);
        return classified?.provider === 'claude-pty' ? [{ runId, entries, classified }] : [];
      }).sort((left, right) => right.classified.atMs - left.classified.atMs || right.runId.localeCompare(left.runId))
        .slice(0, limit);
      runCount = runs.length;
      completedCount = runs.filter(({ classified }) => classified.outcome === 'landed').length;
      readable = report.unreadableLedgers === 0 && runs.every(({ entries }) => {
        const hasUnknownScreens = entries.some((entry) => Object.hasOwn(entry.data, 'claudePtyUnknownScreens'));
        const hasInterventions = entries.some((entry) => Object.hasOwn(entry.data, 'humanInterventions'));
        const unknownScreens = entries.find((entry) => Object.hasOwn(entry.data, 'claudePtyUnknownScreens'))?.data.claudePtyUnknownScreens;
        const interventions = entries.find((entry) => Object.hasOwn(entry.data, 'humanInterventions'))?.data.humanInterventions;
        return hasUnknownScreens && hasInterventions
          && typeof unknownScreens === 'number' && Number.isSafeInteger(unknownScreens) && unknownScreens >= 0
          && typeof interventions === 'number' && Number.isSafeInteger(interventions) && interventions >= 0;
      });
      if (readable) {
        sample = runs.reduce<ClaudePtyMaturitySample>((total, { entries }) => {
          const unknownScreens = entries.find((entry) => Object.hasOwn(entry.data, 'claudePtyUnknownScreens'))!.data.claudePtyUnknownScreens as number;
          const interventions = entries.find((entry) => Object.hasOwn(entry.data, 'humanInterventions'))!.data.humanInterventions as number;
          return {
            runCount: total.runCount + 1,
            completedCount: total.completedCount,
            unknownScreenCount: total.unknownScreenCount + unknownScreens,
            interventionCount: total.interventionCount + interventions,
          };
        }, { runCount: 0, completedCount, unknownScreenCount: 0, interventionCount: 0 });
      }
    } catch {
      readable = false;
    }
  }

  debug.log('oauth.claude-pty', 'maturity-sample', { runCount, completedCount, readable });
  return readable ? sample : null;
}

/** 최근 런의 계수만 판정한다. 표본을 못 읽거나 계수가 불가능하면 성숙으로 추정하지 않는다. */
export function judgeClaudePtyMaturity(sample: ClaudePtyMaturitySample | null | undefined): ClaudePtyMaturity {
  if (!sample || ![sample.runCount, sample.completedCount, sample.unknownScreenCount, sample.interventionCount]
    .every((count) => Number.isSafeInteger(count) && count >= 0)
    || sample.completedCount > sample.runCount || sample.unknownScreenCount > sample.runCount) {
    return { mature: false, why: 'sample-unreadable' };
  }
  if (sample.runCount < 10) return { mature: false, why: 'too-few-samples' };
  if (sample.completedCount / sample.runCount < 0.7) return { mature: false, why: 'completion-below-70' };
  if (sample.unknownScreenCount / sample.runCount > 0.1) return { mature: false, why: 'unknown-screen-above-10' };
  if (sample.interventionCount / sample.runCount > 0.2) return { mature: false, why: 'intervention-above-0.2' };
  return { mature: true };
}
