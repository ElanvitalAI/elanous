// OP turn-end outcome check (OP-NEXT-BEST-ACTION 3/3 · CEO 11-26) — «a turn that ends with only requests and no state
// change is flagged in the retro».
//
// S: on 11-26 OP turns mostly ended with «requested X · will check at HH:MM»: mails out, nothing in the world changed.
// C: the fed-state ledger already has every fact needed: OP turn starts (turn), mails OP posted (mail post · kind) and the
//    state OP changed (cell claim/release/green with seat = actor · work · land · slot · judge).
// Q: which OP turns in the window changed nothing but sent requests?
// A: classifyTurns() slices the window at each OP turn start (a turn runs until the next one starts, or the window end)
//    and sorts each slice: `acted` (≥1 state fact by OP, or an output-kind mail: assign · bulletin · beat · decision) ·
//    `requests-only` (request-kind mails, no state fact) · `quiet` (nothing). The hourly retro draft prints the count and
//    each flagged turn, so OP's two judgement lines start from it.
//
// 세 얼굴: 관측 = the retro draft's «턴 결과» lines · 판단 근거 = per turn: mails (kinds → recipients) vs state facts ·
// 수복과 인계 = a flagged turn names what it sent; the next pulse's NEXT ACTION gives the action that turn should have done.
import type { Fact } from '../fed-state/ledger.js';

/** Fact types that are a change in the world (not talk). */
/** FED-FACT-OP-ACTIONS: a ✋ outcome / decision card (`decision`) and a HOLD change (`hold`) are world changes too. */
export const STATE_FACT_TYPES: ReadonlySet<string> = new Set(['cell', 'work', 'land', 'slot', 'judge', 'green', 'decision', 'hold']);
/** Mail kinds that ARE the output (an assignment, the bulletin, a pulse beat, a decision) rather than a request. */
export const OUTPUT_MAIL_KINDS: ReadonlySet<string> = new Set(['assign', 'bulletin', 'beat', 'decision']);

export type TurnVerdict = 'acted' | 'requests-only' | 'quiet';

export interface TurnOutcome {
  readonly startedAt: string;
  readonly endedAt: string;
  readonly opener: string;
  readonly verdict: TurnVerdict;
  readonly stateChanges: number;
  /** Request-kind mails: «kind→TO». */
  readonly requests: readonly string[];
  readonly outputs: readonly string[];
}

const up = (s: string | undefined) => (s ?? '').trim().toUpperCase();

/** Slice [since, until) at each turn start of `seat` and judge each slice. Facts may be unsorted. */
export function classifyTurns(facts: readonly Fact[], input: { seat: string; since: Date; until: Date }): TurnOutcome[] {
  const seat = up(input.seat);
  const lo = input.since.getTime(); const hi = input.until.getTime();
  const inWin = facts.filter(f => { const t = Date.parse(f.ts); return Number.isFinite(t) && t >= lo && t < hi; })
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const starts = inWin.filter(f => f.type === 'turn' && up(f.seat) === seat);
  return starts.map((s, i) => {
    const from = Date.parse(s.ts); const to = i + 1 < starts.length ? Date.parse(starts[i + 1]!.ts) : hi;
    const slice = inWin.filter(f => { const t = Date.parse(f.ts); return t >= from && t < to; });
    const stateChanges = slice.filter(f => STATE_FACT_TYPES.has(f.type) && up(f.seat) === seat).length;
    const mails = slice.filter(f => f.type === 'mail' && f.state === 'post' && up(f.from) === seat && up(f.to) !== seat);
    const outputs = mails.filter(m => OUTPUT_MAIL_KINDS.has((m.kind ?? '').toLowerCase())).map(m => `${m.kind}→${up(m.to)}`);
    const requests = mails.filter(m => !OUTPUT_MAIL_KINDS.has((m.kind ?? '').toLowerCase())).map(m => `${m.kind ?? 'mail'}→${up(m.to)}`);
    const verdict: TurnVerdict = stateChanges > 0 || outputs.length > 0 ? 'acted' : requests.length > 0 ? 'requests-only' : 'quiet';
    return { startedAt: s.ts, endedAt: new Date(to).toISOString(), opener: s.state ?? '?', verdict, stateChanges, requests, outputs };
  });
}

const hhmm = (iso: string) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));

/** The retro lines: the count first, then each request-only turn (at most `max`). */
export function turnOutcomeLines(turns: readonly TurnOutcome[], max = 5): string[] {
  if (!turns.length) return ['- 턴 결과: OP 턴 0 (fed-state turn 사실 없음)'];
  const flagged = turns.filter(t => t.verdict === 'requests-only');
  const acted = turns.filter(t => t.verdict === 'acted').length;
  const lines = [`- 턴 결과: OP 턴 ${turns.length} · 행동 ${acted} · ⚠ 요청만(상태 변화 0) ${flagged.length} · 조용 ${turns.length - acted - flagged.length}`];
  for (const t of flagged.slice(0, max)) {
    const sent = [...new Set(t.requests)];
    lines.push(`  ⚠ ${hhmm(t.startedAt)} (${t.opener}) 우편 ${t.requests.length}통 ${sent.slice(0, 4).join(' ')}${sent.length > 4 ? ' …' : ''} · 상태 변화 0 — 요청 대신 했어야 할 일은 다음 펄스 NEXT ACTION`);
  }
  if (flagged.length > max) lines.push(`  … ⚠ ${flagged.length - max}턴 더`);
  return lines;
}
