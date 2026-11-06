function truncationMarkerCandidates(originalChars: number): readonly string[] {
  return [
    ` [truncated; originalChars=${originalChars}]`,
    `[truncated; originalChars=${originalChars}]`,
    '[truncated]',
    '…',
  ];
}

/** 길면 머리를 남기고 잘림을 값에 적는다. 반환 길이는 모든 입력에서 `maxChars` 이하다. */
export function boundReadableText(text: string, maxChars: number): { text: string; truncated: boolean; originalChars: number } {
  const originalChars = text.length;
  const limit = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : 0;
  if (originalChars <= limit) return { text, truncated: false, originalChars };
  if (limit === 0) return { text: '', truncated: true, originalChars };
  const marker = truncationMarkerCandidates(originalChars).find((candidate) => candidate.length <= limit) ?? '';
  return { text: `${text.slice(0, limit - marker.length)}${marker}`, truncated: true, originalChars };
}
