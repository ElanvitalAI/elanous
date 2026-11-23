/**
 * CAPSULE-C3-MAIL-ADAPTER — one owner for seat mail (내부 문서 `TURN-CAPSULE-EVENTS` §3.4 ③3 · D9 · D10 · L7).
 *
 * Seat mail reaches a turn by several paths: the per-message notice watcher (1a), the seat plan's absorb (mail → plan
 * item notice), the idle mail wake (1b) and herdr typing (1c, already off for runtime=eln). Without a shared owner the
 * same msgId can open two turns (D9 · #87012). Here a msgId is claimed by exactly one path; any other path that sees it
 * is a duplicate, and an answered msgId never opens a turn again in this process.
 *
 * Failures back off per path (D10): a failed turn parks its mail until the path's back-off time; after
 * {@link MAIL_CIRCUIT_AFTER} failed turns in a row the path's circuit opens and new mail waits too (no turn every 15s
 * against a dead provider). A cancelled or stopped turn is not a failure (contract v1.1): its mail is due again at once (it still spends one attempt: at most one re-injection).
 * A ledger read error (database is locked) is retried soon with its own short back-off, not after a whole poll period.
 *
 * Pure module: no ledger, no queue, no timers. The watcher and the plan share it.
 */
import { emitTurnLife } from '../../debug/turn-life.js';
import type { TurnEvent, TurnEventOutcome } from '../../turn-capsule/contract.js';

export type MailPath = 'notice' | 'plan' | 'mail-wake' | 'herdr';

/** Turns one msgId may take before it is given up (left unseen for A217 overdue / ACK-SLA). Source: #38483 «one retry». */
export const MAIL_TURN_ATTEMPTS = 2;
/** Failed turns in a row from one path that open its circuit. Source: design L7 «requeue ≤ 2 per source». */
export const MAIL_CIRCUIT_AFTER = 2;
/** First failure back-off = one watch period (DEFAULT_SEAT_MAIL_POLL_MS); doubles per failure up to the cap. */
export const MAIL_BACKOFF_BASE_MS = 15_000;
/** Longest a path waits after failures. Source: #38219 REVIEW-2 ① back-off 15s × 2^4. */
export const MAIL_BACKOFF_MAX_MS = 240_000;
/** Ledger read retry after a read error: 1s, doubling, never beyond the watch period. */
export const MAIL_READ_RETRY_BASE_MS = 1_000;

export interface MailClaim {
  /** This path owns these now: it may open a turn for them. */
  readonly granted: readonly number[];
  /** Owned by another path, or already answered: never a second turn. */
  readonly duplicate: readonly number[];
  /** Waiting for this path's back-off (parked after a failure, or the circuit is open). */
  readonly waiting: readonly number[];
}

export interface MailSettle {
  /** Answered: record «seen». */
  readonly seen: readonly number[];
  /** Back to waiting; due again at `retryAt` (cancelled · stopped = now). */
  readonly retry: readonly number[];
  /** Out of attempts: left unseen, loudly. */
  readonly gaveUp: readonly number[];
  readonly retryAt: number;
}

export interface SeatMailAdapter {
  claim(path: MailPath, msgIds: readonly number[]): MailClaim;
  /** The turn that carried these msgIds ended. Only the owning path's ids are settled. */
  settle(path: MailPath, msgIds: readonly number[], outcome: TurnEventOutcome): MailSettle;
  /** The path dropped these before any turn (queue cancel · ledger trim): the claim is released, no attempt counted. */
  release(path: MailPath, msgIds: readonly number[]): void;
  /** Parked mail of this path whose back-off is over — the path offers it again (claim re-grants it). */
  due(path: MailPath): readonly number[];
  /** The path's ledger read failed: how long until the next read (short, doubling, ≤ the poll period). */
  readFailed(path: MailPath): number;
  readOk(path: MailPath): void;
  owner(msgId: number): MailPath | 'done' | null;
  circuitOpen(path: MailPath): boolean;
}

export interface SeatMailAdapterDeps {
  readonly now?: () => number;
  readonly pollMs?: number;
  readonly log?: (event: string, data: Record<string, unknown>) => void;
  /** OBSERVE-TURN-LIFE — `turn-life:mail-deduped` · `:mail-backoff` · `:mail-read-retry` (default emitTurnLife · fail-open). */
  readonly turnLifeLog?: (event: string, data: Record<string, unknown>) => void;
}

type Owned = { path: MailPath; attempts: number; parkedUntil: number | null };
type PathState = { failures: number; notBefore: number; readFailures: number };

export function createSeatMailAdapter(deps: SeatMailAdapterDeps = {}): SeatMailAdapter {
  const now = deps.now ?? Date.now;
  const pollMs = deps.pollMs ?? MAIL_BACKOFF_BASE_MS;
  const log = deps.log ?? (() => {});
  const turnLife = (event: string, data: Record<string, unknown>): void => {
    try { (deps.turnLifeLog ?? emitTurnLife)(event, data); } catch { /* observability is fail-open */ }
  };
  const owned = new Map<number, Owned>();
  const done = new Set<number>();
  const paths = new Map<MailPath, PathState>();
  const pathOf = (path: MailPath): PathState => {
    let state = paths.get(path);
    if (!state) { state = { failures: 0, notBefore: 0, readFailures: 0 }; paths.set(path, state); }
    return state;
  };
  const circuitOpen = (path: MailPath): boolean => {
    const state = pathOf(path);
    return state.failures >= MAIL_CIRCUIT_AFTER && now() < state.notBefore;
  };

  return {
    claim(path, msgIds) {
      const granted: number[] = [];
      const duplicate: number[] = [];
      const waiting: number[] = [];
      for (const id of new Set(msgIds)) {
        const held = owned.get(id);
        if (done.has(id) || (held && held.path !== path)) {
          duplicate.push(id);
          continue;
        }
        if (held && held.parkedUntil !== null && now() < held.parkedUntil) { waiting.push(id); continue; }
        if (!held && circuitOpen(path)) { waiting.push(id); continue; }
        if (held) held.parkedUntil = null;
        else owned.set(id, { path, attempts: 0, parkedUntil: null });
        granted.push(id);
      }
      for (const id of duplicate) turnLife('turn-life:mail-deduped', { eventId: `mail:${id}`, msgId: id, path, owner: done.has(id) ? 'done' : owned.get(id)?.path ?? null });
      if (duplicate.length > 0) log('mail-adapter-duplicate', { path, msgIds: duplicate, owners: duplicate.map((id) => (done.has(id) ? 'done' : owned.get(id)?.path)) });
      if (waiting.length > 0) log('mail-adapter-waiting', { path, msgIds: waiting, circuitOpen: circuitOpen(path), notBefore: pathOf(path).notBefore });
      return { granted, duplicate, waiting };
    },
    settle(path, msgIds, outcome) {
      const state = pathOf(path);
      const mine = [...new Set(msgIds)].filter((id) => owned.get(id)?.path === path);
      const seen: number[] = [];
      const retry: number[] = [];
      const gaveUp: number[] = [];
      let retryAt = now();
      if (outcome === 'responded') {
        state.failures = 0;
        state.notBefore = 0;
        for (const id of mine) { owned.delete(id); done.add(id); seen.push(id); }
        return { seen, retry, gaveUp, retryAt };
      }
      if (outcome === 'failed') {
        state.failures += 1;
        retryAt = now() + Math.min(MAIL_BACKOFF_MAX_MS, pollMs * 2 ** (state.failures - 1));
        state.notBefore = retryAt;
      }
      for (const id of mine) {
        const held = owned.get(id)!;
        // SEAT-MAIL-COALESCE-NOTICE — every unanswered turn spends an attempt (failed · cancelled · stopped): a mail is
        // re-injected at most once (11-23 live: #135347 re-injected 7 turns in a row). Cancel/stop still skip the back-off.
        held.attempts += 1;
        if (held.attempts >= MAIL_TURN_ATTEMPTS) {
          owned.delete(id);
          done.add(id); // given up for this process: no path offers it again; the ledger keeps it unseen
          gaveUp.push(id);
          continue;
        }
        held.parkedUntil = retryAt;
        retry.push(id);
      }
      turnLife('turn-life:mail-backoff', { path, outcome, eventIds: mine.map((id) => `mail:${id}`), retry, gaveUp,
        failures: state.failures, retryAt, circuitOpen: circuitOpen(path) });
      log('mail-adapter-settle', { path, outcome, retry, gaveUp, failures: state.failures, retryAt, circuitOpen: circuitOpen(path) });
      return { seen, retry, gaveUp, retryAt };
    },
    release(path, msgIds) {
      for (const id of msgIds) if (owned.get(id)?.path === path) owned.delete(id);
    },
    due(path) {
      const at = now();
      return [...owned].filter(([, held]) => held.path === path && held.parkedUntil !== null && at >= held.parkedUntil).map(([id]) => id);
    },
    readFailed(path) {
      const state = pathOf(path);
      state.readFailures += 1;
      const inMs = Math.min(pollMs, MAIL_READ_RETRY_BASE_MS * 2 ** (state.readFailures - 1));
      turnLife('turn-life:mail-read-retry', { path, readFailures: state.readFailures, inMs });
      return inMs;
    },
    readOk(path) { pathOf(path).readFailures = 0; },
    owner: (msgId) => (done.has(msgId) ? 'done' : owned.get(msgId)?.path ?? null),
    circuitOpen,
  };
}

/** A seat mail as a bus event (CAPSULE-C1 bus): one dedupe key per msgId, whichever path saw it. */
export function mailTurnEvent(input: { msgId: number; text: string; arrivedAt: number; urgent: boolean }): TurnEvent {
  return { id: `mail-${input.msgId}`, source: input.urgent ? 'urgent-mail' : 'mail', dedupeKey: `mail:${input.msgId}`,
    arrivedAt: input.arrivedAt, text: input.text };
}
