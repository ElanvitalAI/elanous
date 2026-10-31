/** Stable TDD terminal-evidence tags shared by the producer and Pod result mapper. */
export const TDD_RED_TAG = 'tdd-red' as const;
export const TDD_GREEN_TAG = 'tdd-green' as const;
export const TDD_RECORD_TAGS = [TDD_RED_TAG, TDD_GREEN_TAG] as const;
export type TddRecordTag = typeof TDD_RECORD_TAGS[number];

export function isTddRecordTag(value: unknown): value is TddRecordTag {
  return value === TDD_RED_TAG || value === TDD_GREEN_TAG;
}
