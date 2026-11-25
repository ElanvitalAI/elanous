/**
 * MAIL-ANTI-FLOOD F·G — the seat TUI side of the diverted ledgers (`src/msg/diverted-mail.ts`).
 *
 *   self-wake  → armed through the ScheduleWakeup door (the same door as the model's own wakes) · a refused arm
 *                (cap · not ready) leaves the entry in the ledger for the next tick (nothing is dropped)
 *   coach-note → one passive line per 30 min (rides the next turn · never opens one by itself as mail did)
 *   folded     → one passive digest line per 10 min
 *   retro-turn → ONE internal turn (origin retro) through the internal-turn door — never ScheduleWakeup, so the wake cap
 *                and late-wake folding cannot swallow it · a refused open leaves the entry for the next tick · older
 *                than RETRO_TURN_STALE_DROP_MS = dropped with one line (the graph already wrote the measured draft)
 *   turn start → a turn stamp (G reads «mail-opened turns in the last hour» from it · RAIL30 ①)
 *   new folds  → handed to the seat's Q9 flood meter (RAIL30 ②: a folded post is still an arrival for the flood rule)
 *
 * 세 얼굴: 관측 = debug.log('msg', 'msg.diverted.drained', {seat, ledger, count}) · 인지 = the ledger cursors ·
 *          수복과 인계 = a failed arm keeps the entry; the next tick retries.
 */
import { debug } from '../debug/log.js';
import { coachNoteLine, divertedLineCount, divertedRoot, divertedSince, foldedDigestLine, noteTurnStamp, pendingDiverted, takeDiverted, type DivertedEntry } from '../msg/diverted-mail.js';

export const FOLDED_DIGEST_WINDOW_MS = 10 * 60_000;
/** RAIL30 ④ — a self-wake older than this when the TUI drains it is dropped (one line), not replayed. */
export const SELF_WAKE_STALE_DROP_MS = 2 * 60 * 60_000;
/** A graph retro turn not opened within this long is dropped (one line) — the next hour's graph run writes a new draft. */
export const RETRO_TURN_STALE_DROP_MS = 90 * 60_000;
/** How often the TUI drains the ledgers. */
export const DIVERTED_FEED_TICK_MS = 30_000;

export interface SelfWakeCoachFeedDeps {
  seat: string;
  root?: string;
  now?: () => number;
  /** Arm one wake (ScheduleWakeup door). false = refused (the entry stays). */
  schedule(reason: string, dueAtMs: number | null): boolean;
  /** Open one graph retro turn (internal-turn door · origin retro). false = refused (the entry stays). Absent = the ledger is not drained. */
  openRetroTurn?(prompt: string): boolean;
  /** Queue one passive notice (rides the next turn). */
  enqueuePassive(line: string): void;
  log?: (event: string, data: Record<string, unknown>) => void;
  /** RAIL30 ② — posts G folded since the last tick (the Q9 flood meter counts them as arrivals). */
  onFoldedArrivals?: (entries: readonly DivertedEntry[]) => void;
}

export interface SelfWakeCoachFeed {
  tick(): { wakes: number; coach: number; folded: number; retro: number };
  /** `mailOpened` (default true) — false for self-wake / goal-drive / scheduled / human turns (RAIL30 ①). */
  noteTurnStarted(mailOpened?: boolean): void;
}

/** Turn sources a mail opened (MessageSource-shaped · the notice/queue label when the turn carries no `from`). */
const MAIL_ORIGINS: ReadonlySet<string> = new Set(['msg-wake']);
const MAIL_NOTICE_SOURCES: readonly string[] = ['seat-mail', 'ceo-ingress', 'msg-wake'];

/**
 * RAIL30 ① — was this turn opened by mail? another seat's mail (`from.kind agent`) · a msg-wake internal turn · a queued
 * seat-mail notice (no `from`, label source seat-mail*). A self-wake, goal drive, scheduled wake or a person's own
 * line is not — those do not count toward G's turns/h.
 */
export function turnOpenedByMail(from: { kind?: string; origin?: string } | undefined, noticeSource?: string | null): boolean {
  if (from?.kind === 'agent') return true;
  if (from?.kind === 'system') return MAIL_ORIGINS.has(from.origin ?? '');
  if (from?.kind === 'human') return false;
  const source = (noticeSource ?? '').trim();
  return MAIL_NOTICE_SOURCES.some((prefix) => source.startsWith(prefix));
}

export function createSelfWakeCoachFeed(deps: SelfWakeCoachFeedDeps): SelfWakeCoachFeed {
  const root = deps.root ?? divertedRoot();
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? ((event, data) => { try { debug.log('msg', event, data); } catch { /* fail-open */ } });
  let lastCoachAt: number | null = null;
  let lastFoldAt: number | null = null;
  // RAIL30 ② — folds already counted (history before this TUI started is not a burst).
  let foldSeen = (() => { try { return divertedLineCount('folded', deps.seat, root); } catch { return 0; } })();
  return {
    tick() {
      const at = now();
      const out = { wakes: 0, coach: 0, folded: 0, retro: 0 };
      try {
        // RAIL30 ④ — a self-wake overdue by > 2 h (the TUI was down) is dropped, not replayed: one line, no wake.
        let dropped = 0;
        const wakes = takeDiverted('self-wake', deps.seat, (e) => {
          const due = Date.parse(e.dueAt ?? e.at);
          if (Number.isFinite(due) && at - due >= SELF_WAKE_STALE_DROP_MS) { dropped += 1; return true; }
          return deps.schedule(e.body, e.dueAt ? Date.parse(e.dueAt) : null);
        }, root);
        out.wakes = wakes.length - dropped;
        if (dropped > 0) { deps.enqueuePassive(`[self-wake] dropped ${dropped} stale wakes (overdue > 2 h)`); log('msg.diverted.stale-dropped', { seat: deps.seat, ledger: 'self-wake', count: dropped }); }
      } catch (error) { log('msg.diverted.drain-failed', { seat: deps.seat, ledger: 'self-wake', error: String(error).slice(0, 160) }); }
      if (deps.openRetroTurn) {
        try {
          let dropped = 0;
          let opened = false;
          takeDiverted('retro-turn', deps.seat, (e) => {
            const at0 = Date.parse(e.at);
            if (Number.isFinite(at0) && at - at0 >= RETRO_TURN_STALE_DROP_MS) { dropped += 1; return true; }
            if (opened) return false; // one turn per tick — the rest wait for the next tick
            opened = deps.openRetroTurn!(e.body);
            return opened;
          }, root);
          out.retro = opened ? 1 : 0;
          if (opened) log('msg.diverted.retro-opened', { seat: deps.seat });
          if (dropped > 0) { deps.enqueuePassive(`[retro] dropped ${dropped} graph retro turns not opened within 90 min (the measured draft is already in the retro file)`); log('msg.diverted.stale-dropped', { seat: deps.seat, ledger: 'retro-turn', count: dropped }); }
        } catch (error) { log('msg.diverted.drain-failed', { seat: deps.seat, ledger: 'retro-turn', error: String(error).slice(0, 160) }); }
      }
      try {
        const line = coachNoteLine(pendingDiverted('coach-note', deps.seat, root), at, lastCoachAt);
        if (line) { out.coach = takeDiverted('coach-note', deps.seat, () => true, root).length; deps.enqueuePassive(line); lastCoachAt = at; }
      } catch (error) { log('msg.diverted.drain-failed', { seat: deps.seat, ledger: 'coach-note', error: String(error).slice(0, 160) }); }
      if (deps.onFoldedArrivals) {
        try {
          const fresh = divertedSince('folded', deps.seat, foldSeen, root);
          foldSeen = fresh.total;
          if (fresh.entries.length > 0) deps.onFoldedArrivals(fresh.entries);
        } catch (error) { log('msg.diverted.drain-failed', { seat: deps.seat, ledger: 'folded-meter', error: String(error).slice(0, 160) }); }
      }
      try {
        if (lastFoldAt === null || at - lastFoldAt >= FOLDED_DIGEST_WINDOW_MS) {
          const line = foldedDigestLine(pendingDiverted('folded', deps.seat, root));
          if (line) { out.folded = takeDiverted('folded', deps.seat, () => true, root).length; deps.enqueuePassive(line); lastFoldAt = at; }
        }
      } catch (error) { log('msg.diverted.drain-failed', { seat: deps.seat, ledger: 'folded', error: String(error).slice(0, 160) }); }
      if (out.wakes + out.coach + out.folded + out.retro > 0) log('msg.diverted.drained', { seat: deps.seat, ...out });
      return out;
    },
    noteTurnStarted(mailOpened = true) { noteTurnStamp(deps.seat, now(), root, mailOpened); },
  };
}
