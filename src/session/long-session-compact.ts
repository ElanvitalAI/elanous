// ── OP-LONG-SESSION-COMPACT core + ELN-COMPACT-REAL turn-start trigger ──
//
// D1 root cause (OP-LONG-SESSION-COMPACT): `runTurn` trimmed every request to its input cap
// (DEFAULT_TOKEN_BUDGET = 24k) BEFORE anything checked the compaction trigger, so the oldest rows —
// the seat instruction first — were dropped silently by the trim. The D1 fix clamped the existing
// ratio threshold to the input cap and measured it on the request as sent.
//
// ★ ELN-COMPACT-REAL(OP #135458 §4-4①) — the request-as-sent basis fired every turn on the fixed
// prefix alone (audit W3): a 30k-token system prompt crossed the 24k trigger on turn 1 of a fresh
// session. The turn-start trigger now measures the RECORD only (the stored history rows — fixed
// prefix excluded): fire when the record reaches 16k tokens OR the whole measured input (prompt +
// turn-volatile blocks + images) reaches 60k tokens, whichever comes first. The config working
// budget no longer lowers the turn-start trigger; the 24k input cap, the trim and the session
// compactor are unchanged.

/** ★ ELN-COMPACT-REAL(OP #135458 §4-4①) — 기록 기준: 저장된 기록(고정 접두 제외)이 이만큼 자라면 발화. */
export const TURN_COMPACT_HISTORY_TOKENS = 16_000; // 출처: #135458
/** ★ ELN-COMPACT-REAL(OP #135458 §4-4①) — 전체 밸브: 실측 전체 입력(접두·턴 휘발성·이미지 포함)이
 *  이만큼이면 기록이 짧아도 발화(고정 접두만으로 터지는 낭비도 잡는다). */
export const TURN_COMPACT_FULL_INPUT_TOKENS = 60_000; // 출처: #135458

/** §4-4① — turn-start compaction fires on the record (16k) OR the full measured input (60k). */
export function shouldFireTurnStartCompact(historyUsedTokens: number, fullInputTokens: number): boolean {
  return historyUsedTokens >= TURN_COMPACT_HISTORY_TOKENS || fullInputTokens >= TURN_COMPACT_FULL_INPUT_TOKENS;
}

interface WireLike { role: string; content: string | unknown[] }

export interface PreservingTrimResult<T> {
  kept: T[];
  dropped: number;
  used: number;
  /** True when even the preserved rows exceed the cap — the caller must fail visibly. */
  overBudget: boolean;
}

/**
 * Trim used after a turn-start compaction: drops the oldest conversation rows first but always keeps
 * every system row (system prompt · summary · pinned), the anchor (first user message) and the most
 * recent user turn (the last user message and everything after it).
 */
export function trimKeepingAnchorAndLatestTurn<T extends WireLike>(
  wire: T[],
  capTokens: number,
  measure: (messages: T[]) => number,
): PreservingTrimResult<T> {
  const firstUser = wire.findIndex(message => message.role === 'user');
  let lastUser = -1;
  for (let i = wire.length - 1; i >= 0 && lastUser < 0; i--) if (wire[i]!.role === 'user') lastUser = i;
  const preserved = (index: number) => wire[index]!.role === 'system' || index === firstUser || (lastUser >= 0 && index >= lastUser);
  const removed = new Set<number>();
  const current = () => wire.filter((_, index) => !removed.has(index));
  let used = measure(wire);
  for (let index = 0; index < wire.length && used > capTokens; index++) {
    if (preserved(index)) continue;
    removed.add(index);
    used = measure(current());
  }
  return { kept: current(), dropped: removed.size, used, overBudget: used > capTokens };
}
