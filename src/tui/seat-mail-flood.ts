// SEAT-MAIL-FLOOD (Q9 · ISA-18.2 / EEMUA 191 alarm-flood rule · OP 11-25 «OP 수신 30분 128통»)
//
// S: a burst of mail to one seat opened turn after turn; the seat's own work never finished and every knock re-read
//    the same pile.
// C: structured fields only (crown id · origin kind · kind · intent · priority) · the seat is never cut off from what
//    must interrupt · nothing is dropped — a folded mail stays queued and rides the next turn / digest.
// Q: when does a seat stop letting ordinary mail open turns, and when does it come back?
// A: count turn-opening arrivals per seat over a sliding {@link FLOOD_WINDOW_MS}: more than {@link FLOOD_ENTER} → flood
//    mode; below {@link FLOOD_EXIT} → normal (hysteresis). In flood only crown · human · ✋ · alert · P0 open a turn.
//
// RAIL30 ② one owner each: the sender-side G (msg/post-gate.ts) only folds per sender at post time and never folds what
// this rule would let through; this meter decides turn-opening and counts G's folds as arrivals (noteFolded).
//
// 세 얼굴: 관측 = debug.log('msg.flood', 'enter' | 'exit', {seat, rate}) · 판단 근거 = {@link createFloodMeter} ·
// 수복과 인계 = the folded mail stays in the queue (next turn · digest); exit is automatic below the low-water mark.

export const FLOOD_WINDOW_MS = 10 * 60_000;
/** Enter flood when MORE than this many turn-opening mails arrived in the window. */
export const FLOOD_ENTER = 10;
/** Leave flood when FEWER than this many arrived in the window. */
export const FLOOD_EXIT = 5;

const EXEMPT_KINDS: ReadonlySet<string> = new Set(['alert', 'hand', 'hand-raise', 'needs-human']);

export interface FloodMail {
  readonly crownDirective?: string | null;
  readonly origin?: { readonly kind?: string } | null;
  readonly kind?: string | null;
  readonly intent?: string | null;
  readonly priority?: number | null;
}

/** May this mail open a turn even in flood mode? crown · a person · ✋ · alert · P0/urgent. */
export function floodExempt(m: FloodMail): boolean {
  if (typeof m.crownDirective === 'string' && m.crownDirective.trim()) return true;
  if (m.origin?.kind === 'human') return true;
  if (EXEMPT_KINDS.has((m.kind ?? '').trim().toLowerCase())) return true;
  if ((m.intent ?? '').trim().toLowerCase() === 'alert') return true;
  return (m.priority ?? 0) >= 1;
}

export type FloodVerdict = { readonly open: boolean; readonly flood: boolean; readonly rate: number };

export interface FloodMeter {
  /** One turn-opening arrival at `at`: may it open a turn? (exempt mail always may; it still counts toward the rate) */
  note(m: FloodMail, at: number): FloodVerdict;
  /**
   * RAIL30 ② — arrivals the sender-side back-pressure (G) folded before they reached the mailbox: they count toward the
   * rate (Q9 owns the turn-opening decision; G folding first must not hide a burst from it). `arrivedAt` = each fold's time.
   */
  noteFolded(arrivedAt: readonly number[], at: number): { readonly flood: boolean; readonly rate: number };
  /** Current state at `at` (re-evaluates the exit mark without an arrival). */
  state(at: number): { readonly flood: boolean; readonly rate: number };
}

export function createFloodMeter(seat: string, log: (event: 'enter' | 'exit', data: { seat: string; rate: number }) => void = () => {}): FloodMeter {
  let arrivals: number[] = [];
  let flood = false;
  const settle = (at: number): number => {
    arrivals = arrivals.filter((t) => at - t < FLOOD_WINDOW_MS && t <= at);
    const rate = arrivals.length;
    if (!flood && rate > FLOOD_ENTER) { flood = true; log('enter', { seat, rate }); }
    else if (flood && rate < FLOOD_EXIT) { flood = false; log('exit', { seat, rate }); }
    return rate;
  };
  return {
    note(m, at) {
      settle(at);
      arrivals.push(at);
      const rate = settle(at);
      return { open: !flood || floodExempt(m), flood, rate };
    },
    noteFolded(arrivedAt, at) {
      for (const t of arrivedAt) if (Number.isFinite(t)) arrivals.push(Math.min(t, at));
      arrivals.sort((a, b) => a - b);
      const rate = settle(at);
      return { flood, rate };
    },
    state(at) { const rate = settle(at); return { flood, rate }; },
  };
}
