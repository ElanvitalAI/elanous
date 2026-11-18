// RELEASE-RESUME-AFTER-CUT-PUSHED: the cut node is `cut-branch`; legacy runs carry `version-release`
// (cut + inline prebuild). Every consumer reads both so old and new run states resolve the same cut.
export type ReleaseCutRecord = { outcome?: unknown; commit?: unknown; refreshedFrom?: unknown } | undefined;

export function releaseCutRecord(context: { outputs?: Record<string, unknown> } | undefined | null): ReleaseCutRecord {
  const outputs = context?.outputs;
  const record = outputs?.['cut-branch'] ?? outputs?.['version-release'];
  return (record ?? undefined) as ReleaseCutRecord;
}
