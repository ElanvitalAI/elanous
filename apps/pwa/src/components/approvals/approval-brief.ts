export function nextMergeabilityPoll(attempt: number, mergeable: string): number | null {
  return mergeable === 'UNKNOWN' && attempt < 3 ? 3_000 : null;
}

export function mergeabilityButtonLabel(attempt: number, mergeable: string): string {
  if (mergeable !== 'UNKNOWN') return '승인하고 머지';
  return nextMergeabilityPoll(attempt, mergeable) === null ? '확인 종료' : '확인 중…';
}

/**
 * 머지 가능 여부가 `UNKNOWN` 인 동안 한 건 조회로 다시 읽는다(GitHub 은 조회를 받은 뒤 계산한다).
 * 호출·대기는 주입한다 — 카드는 이 함수를 부르기만 한다(시험이 실제 호출 횟수를 잰다).
 */
export async function pollMergeabilityUntilKnown<T extends { mergeable: string }>(
  get: () => Promise<T>,
  opts: { sleep: (ms: number) => Promise<void>; onDetail?: (detail: T) => void; onAttempt?: () => void; isActive?: () => boolean },
): Promise<{ attempts: number; last?: T }> {
  let attempts = 0;
  let last: T | undefined;
  let delay = nextMergeabilityPoll(attempts, 'UNKNOWN');
  while (delay !== null) {
    await opts.sleep(delay);
    if (opts.isActive && !opts.isActive()) break;
    attempts++;
    try {
      last = await get();
      opts.onDetail?.(last);
    } catch { /* 한 번 실패해도 상한까지는 다시 본다 */ }
    opts.onAttempt?.();
    delay = nextMergeabilityPoll(attempts, last?.mergeable ?? 'UNKNOWN');
  }
  return { attempts, ...(last ? { last } : {}) };
}
