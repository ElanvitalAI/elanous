// ── Wave 5 · auto-compact circuit breaker + verify-probe state ──
//
// Two pieces of process-local state that the chat loop reads/writes
// around each turn:
//
//   1) Consecutive auto-compact failures — when summarize() throws
//      or returns null three times in a row, the breaker trips and
//      auto-compact stops firing until the user manually clears it
//      via `/compact --reset` (Wave 6 follow-up).
//
//   2) Verify-probe opt-in — Gemini-style "did the summary lose
//      anything important?" check. Off by default because it's a
//      second LLM round-trip per compact.

const MAX_CONSECUTIVE_FAILURES = 3;

let consecutiveFailures = 0;
let breakerTripped = false;
let breakerReason = '';
let verifyProbeEnabled = false;

export function recordAutoCompactSuccess(): void {
  consecutiveFailures = 0;
  breakerTripped = false;
  breakerReason = '';
}

export function recordAutoCompactFailure(reason: string): {
  tripped: boolean;
  consecutive: number;
} {
  consecutiveFailures += 1;
  if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    breakerTripped = true;
    breakerReason = reason;
  }
  return { tripped: breakerTripped, consecutive: consecutiveFailures };
}

export function isAutoCompactBreakerTripped(): boolean {
  return breakerTripped;
}

export function getAutoCompactBreakerReason(): string {
  return breakerReason;
}

export function resetAutoCompactBreaker(): void {
  consecutiveFailures = 0;
  breakerTripped = false;
  breakerReason = '';
}

export function setVerifyProbeEnabled(on: boolean): void {
  verifyProbeEnabled = on;
}

export function isVerifyProbeEnabled(): boolean {
  return verifyProbeEnabled;
}

// ── ★ ELN-COMPACT-REAL(OP #135458 §4-4③) — no-op force backoff ──
//
// A turn-start force that ended in no-op (nothing could be compacted) buys nothing by repeating
// on the next turn: the compactor holds off re-forcing until the stored record has grown +25%
// past the level it measured at the last no-op.

/** sessionId → record tokens measured at the last no-op force. */
const noOpBackoff = new Map<string, number>();
/** §4-4③ 배율 — 재force 보류가 풀리는 기록 성장률. */
const NO_OP_BACKOFF_GROWTH = 1.25; // 출처: #135458

/** Record (or refresh) the hold level after a no-op force for this session. */
export function recordNoOpBackoff(sessionId: string, historyUsedTokens: number): void {
  noOpBackoff.set(sessionId, historyUsedTokens);
}

/** Clear the hold after a compaction actually fired for this session. */
export function clearNoOpBackoff(sessionId: string): void {
  noOpBackoff.delete(sessionId);
}

/** §4-4③ — true while the record is still within +25% of the last no-op level (re-force withheld). */
export function noOpBackoffHeld(sessionId: string, historyUsedTokens: number): boolean {
  const held = noOpBackoff.get(sessionId);
  return typeof held === 'number' && historyUsedTokens < held * NO_OP_BACKOFF_GROWTH;
}

// ── ELN-COMPACT-EVERY-TURN — regrow hold after a compaction that fired ──
//
// A long seat's record keeps every person row verbatim (COMPACT P0), so one compaction cannot bring it under the
// 16k trigger; the turn-start force then fired on EVERY turn (OP 11-24: record 58k→94k tokens, full input >60k)
// and every summary rewrite broke the provider prompt cache at the head of the history (OP cache hit 54% vs
// 81–88% on other terra seats). After a compaction fires, the next one waits until the record has regrown by
// a full trigger's worth past the level the compaction left (hysteresis: the summary is a cache boundary).

/** sessionId → record tokens right after the last compaction that fired. */
const regrowHold = new Map<string, number>();

/** Record the level a fired compaction left for this session. */
export function recordCompactRegrowHold(sessionId: string, historyTokensAfter: number): void {
  regrowHold.set(sessionId, historyTokensAfter);
}

/** True while the record has not regrown by `regrowTokens` past the last fired compaction's level. */
export function compactRegrowHeld(sessionId: string, historyUsedTokens: number, regrowTokens: number): boolean {
  const after = regrowHold.get(sessionId);
  return typeof after === 'number' && historyUsedTokens < after + regrowTokens;
}

/** Test-only — also re-exported through `index.ts` for production
 *  callers that need to clear state between runs (multi-session
 *  CLI). */
export function resetAutoCompactStateForTest(): void {
  consecutiveFailures = 0;
  breakerTripped = false;
  breakerReason = '';
  verifyProbeEnabled = false;
  noOpBackoff.clear();
  regrowHold.clear();
}
