export type ClaudePtyMaturity =
  | { readonly mature: true }
  | { readonly mature: false; readonly why: 'too-few-samples' | 'completion-below-70' | 'unknown-screen-above-10' | 'intervention-above-0.2' | 'sample-unreadable' };

export type ClaudePtyMaturitySample = {
  readonly runCount: number;
  readonly completedCount: number;
  readonly unknownScreenCount: number;
  readonly interventionCount: number;
};

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
