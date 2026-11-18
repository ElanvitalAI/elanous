/**
 * ELN-TURN-STALL-WATCHDOG — the turn-level report of the no-progress watchdog (src/llm/turn-progress.ts).
 * The tool loop fires; this collects the fires of one core turn and, when the turn ends, posts exactly ONE mail line
 * (to OP and any configured owner) through the existing mail API, plus one `core.turn` event. A turn whose watchdog
 * never fired posts nothing.
 */
import { debug } from '../debug/log.js';
import type { TurnNoProgressFire } from '../llm/turn-progress.js';
import type { MsgStore } from '../msg/msg-store.js';

export type TurnStallOutcome =
  /** A later provider answered after the stall. */
  | { kind: 'recovered'; provider: string | null }
  /** Every provider was tried (or the provider was pinned): the turn ended with an error. */
  | { kind: 'exhausted'; error: string }
  | { kind: 'aborted' };

/** Sends one line from `from` to each recipient. Production: msg-store post + wake (same path as `eln msg post`). */
/** #38515 r1 MF3/MF4: what the mailer actually did, per recipient — stored ids, and each post/wake failure on its own. */
export interface TurnStallMailResult {
  posted: Array<{ to: string; id: number }>;
  failed: Array<{ to: string; stage: 'post' | 'wake'; error: string }>;
}
export type TurnStallMailer = (input: { from: string; to: readonly string[]; body: string }) => Promise<TurnStallMailResult | void>;

/** No owner field exists in the seat registry (v2 has none), so the only built-in recipient is OP;
 *  `llm.turnNoProgressMailTo` adds owners per seat. Never the stalled seat itself (a self-notice would open a turn
 *  on the same dead chain). */
export const TURN_STALL_DEFAULT_RECIPIENTS: readonly string[] = ['OP'];

const minutes = (ms: number): number => Math.max(1, Math.round(ms / 60_000));

export function turnStallMailLine(input: {
  seat: string;
  sessionId: string;
  fires: readonly TurnNoProgressFire[];
  outcome: TurnStallOutcome;
}): string {
  const first = input.fires[0]!;
  const chain = input.fires.map((fire) => `${fire.provider}/${fire.model}`).join(' → ');
  const tail = input.outcome.kind === 'recovered'
    ? `recovered on ${input.outcome.provider ?? 'unknown provider'}`
    : input.outcome.kind === 'exhausted'
      ? `chain exhausted, turn ended with error: ${input.outcome.error.slice(0, 160)}`
      : 'turn aborted';
  return `[turn-stall] ${input.seat} · no output for ${minutes(first.quietMs)} min (limit ${minutes(first.limitMs)} min) on ${chain} · ${tail} · session ${input.sessionId.slice(0, 8)}`;
}

export interface TurnStallReporterDeps {
  seat: string | null;
  sessionId: string;
  recipients: readonly string[];
  mailer: TurnStallMailer;
  log?: (event: string, data: Record<string, unknown>, level: 'warn' | 'error') => void;
}

export interface TurnStallReporter {
  note(fire: TurnNoProgressFire): void;
  /** Ends the turn: one event and one mail line when anything fired, otherwise nothing. Idempotent. */
  finish(outcome: TurnStallOutcome): Promise<void>;
  readonly fired: number;
}

export function createTurnStallReporter(deps: TurnStallReporterDeps): TurnStallReporter {
  const fires: TurnNoProgressFire[] = [];
  let finished = false;
  const log = deps.log ?? ((event, data, level) => { debug.log('core.turn', event, data, { level }); });
  return {
    get fired() { return fires.length; },
    note(fire) { fires.push(fire); },
    async finish(outcome) {
      if (finished || fires.length === 0) return;
      finished = true;
      const data = { sessionId: deps.sessionId, seat: deps.seat, fires: fires.length, outcome: outcome.kind,
        providers: fires.map((fire) => fire.provider), quietMs: fires[0]!.quietMs, limitMs: fires[0]!.limitMs };
      log('turn-stall', data, outcome.kind === 'exhausted' ? 'error' : 'warn');
      // Not a seat (no `seats/<id>` cwd, no COORD_ID): there is no mailbox to send from — said, not skipped silently.
      if (deps.seat === null) { log('turn-stall-mail-skipped', { sessionId: deps.sessionId, reason: 'no-seat' }, 'warn'); return; }
      const to = [...new Set(deps.recipients.filter((recipient) => recipient !== deps.seat))];
      if (to.length === 0) { log('turn-stall-mail-skipped', { sessionId: deps.sessionId, reason: 'no-recipient' }, 'warn'); return; }
      const body = turnStallMailLine({ seat: deps.seat, sessionId: deps.sessionId, fires, outcome });
      try {
        const result = await deps.mailer({ from: deps.seat, to, body });
        const posted = result ? result.posted.map((p) => p.to) : [...to];
        if (posted.length > 0) log('turn-stall-mailed', { sessionId: deps.sessionId, to: posted, ...(result ? { ids: result.posted.map((p) => p.id) } : {}) }, 'warn');
        // #38515 r1 MF4: post and wake failures are error events of their own — never folded into «mailed».
        for (const failure of result?.failed ?? []) {
          log('turn-stall-mail-failed', { sessionId: deps.sessionId, to: [failure.to], stage: failure.stage, error: failure.error }, 'error');
        }
      } catch (error) {
        log('turn-stall-mail-failed', { sessionId: deps.sessionId, to, error: error instanceof Error ? error.message : String(error) }, 'error');
      }
    },
  };
}

/** The existing mail path (`self-timer-watch` does the same): persist in the ledger, then wake each recipient. */
/** The two outside-world doors the mailer uses — injectable so the per-recipient failure paths are testable. */
export interface TurnStallMailerDeps {
  openStore(): Promise<Pick<MsgStore, 'post' | 'close'>>;
  wake(recipient: string, id: number, meta: { from: string; kind: string }): Promise<unknown>;
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function createTurnStallMailer(deps: TurnStallMailerDeps): TurnStallMailer {
  return async ({ from, to, body }) => {
    const result: TurnStallMailResult = { posted: [], failed: [] };
    const store = await deps.openStore();
    try {
      // #38515 r1 MF3: one recipient's failed post never hides the others — each is stored (or failed) on its own.
      for (const recipient of to) {
        try { result.posted.push({ to: recipient, id: store.post({ from, to: recipient, kind: 'turn-stall', intent: 'alert', body }).id }); }
        catch (error) { result.failed.push({ to: recipient, stage: 'post', error: errorText(error) }); }
      }
    } finally {
      try { store.close(); } catch { /* the posts above are already committed or already failed */ }
    }
    // Every stored mail is woken on its own, even when another recipient's post failed.
    for (const { to: recipient, id } of result.posted) {
      try { await deps.wake(recipient, id, { from, kind: 'turn-stall' }); }
      // #38515 r1 MF4: a failed wake is reported (the mail is stored; seat-autowake still reads unread mail).
      catch (error) { result.failed.push({ to: recipient, stage: 'wake', error: errorText(error) }); }
    }
    return result;
  };
}

export const defaultTurnStallMailer: TurnStallMailer = createTurnStallMailer({
  openStore: async () => (await import('../msg/msg-store.js')).openMsgStore(),
  wake: async (recipient, id, meta) => (await import('../loops/msg-wake.js')).wakeRecipient(recipient, id, meta),
});
