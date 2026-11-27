// NEED-HUMAN-PUSH (11-24): when the TUI publishes the needs-person block it also pushes ONE structured mail up the
// escalation ladder  seat → its space coordinator → OP → CEO (decision card). Push, not polling.
//   • one mail per blockId (the same block re-rendered never re-posts)
//   • no reply in ESCALATE_AFTER_MS and still blocked → ONE forward to the next rung («escalated from <rung> after 5m»)
//   • a reply (replyTo = one of this block's mail ids — a structured field, never text matching) from ANY rung resumes the seat
//   • the rung already handled it (11-25 06:18 UX→OP: OP answered in 19 s, the CEO still got the card at 06:25) → no next rung.
//     Checked at the 5-min check only (never an always-on poll), against the shared mail ledger: the rung's turn took the mail in
//     (seen/done receipt) · the rung mailed the blocked seat after routing · the mail row was acked. The ✋ stays until the seat resumes.
//   • a seat with no coordinator, or that IS the coordinator, skips straight to the next rung; OP itself goes to the CEO card
// Machine fields ride in `refs` (block:/seat:/pane:/reason:) and `correlationId` = blockId; priority comes from intent=decision (P1).
import type { BlockReason, HandCause } from '../agent-events/protocol.js';
import type { MessageEnvelope } from '../msg/msg-store.js';
import { classifyHandBlock, handAskCell, handAskRef, handNeedsClassifier, resolveHandRoot, waitedOnRefs, routeHandBlock, type HandClassification, type HandRootClassifier } from '../kit/mail-route/hand-route.js';

export const ESCALATE_AFTER_MS = 5 * 60_000;

export interface NeedsHumanDeps {
  /** This seat's name; null = not a seat TUI (nothing is pushed). */
  readonly seat: () => string | null;
  readonly paneId: () => string;
  /** The seat's space coordinator (els workspace coordinator), or null/undefined when it has none. */
  readonly coordinatorOf: () => string | null | undefined;
  /** BEACON-LADDER — the ✋'s urgency field (normal | urgent | security | crown-conflict); absent = normal (no ref). */
  readonly urgencyOf?: (reason: string, detail: string) => 'normal' | 'urgent' | 'security' | 'crown-conflict';
  /** Posts one mail; returns its ledger id. */
  readonly postMail: (envelope: MessageEnvelope) => number | undefined;
  /** The CEO rung: an existing `decisions raise` card. */
  readonly raiseDecision: (card: { title: string; seat: string; reason: BlockReason; blockId: string; summary: string }) => void;
  /** A rung replied: resume the seat with the reply text as its input. */
  readonly resumeWith: (text: string) => void;
  /** Did `rung` handle mail #msgId (sent by `seat`) since it was routed? null = not yet (the ladder escalates as before). */
  readonly handledBy?: (input: { msgId: number; rung: string; seat: string }) => NeedsHumanHandledBy | null;
  /** Ack mail #msgId for `rung` once handled (its ✉ count drops); a no-op when already acked. */
  readonly ackFor?: (rung: string, msgId: number) => void;
  readonly setTimer: (fn: () => void, ms: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
  readonly newBlockId?: () => string;
  readonly log?: (event: string, data: Record<string, unknown>) => void;
  /** KIT mail-route hand-route — the Jev classifier, asked only when the structured codes leave a block unclear
   *  (absent = old rung at once; unavailable / unclear = old rung). */
  readonly classifyHand?: HandRootClassifier;
  /** HAND-RAISE-DOMAIN-ROUTING — the cell this seat holds (its ✋ cell for `hand-ask:` and a `cell-owner` route). */
  readonly cellOf?: (seat: string) => string | null;
  /** The checklist owner of a cell (hand-routes.yaml `cell-owner`). */
  readonly cellOwnerOf?: (cell: string) => string | null;
  /** The answer already given to ✋ mail #msgId (a by-reference repeat of an answered ask) — null = still open. */
  readonly answerOf?: (msgId: number, seat: string) => string | null;
}

export type NeedsHumanHandledBy = 'turn-ack' | 'reply' | 'ack';

export interface NeedsHumanArrival { readonly msgId?: number; readonly replyTo?: number; readonly text: string }

export interface NeedsHumanPush {
  /** The TUI published the needs-person block. */
  /** `cause` (WRITER-CHECK-RESOLVER) rides as ref `cause:<c>` — the steward answers that family itself. */
  blocked(reason: BlockReason, detail: string, cause?: HandCause): void;
  /** The block is over (a person typed, or a turn was opened by a person). */
  resumed(): void;
  /** Mail arrivals of this seat: a structured reply to this block's mail resumes the seat. Returns true when it did. */
  noteArrivals(arrivals: readonly NeedsHumanArrival[] | undefined): boolean;
  activeBlockId(): string | null;
  /** Resolves when the first-rung mail of the latest block was routed (immediate unless the classifier was asked). */
  routing(): Promise<void>;
}

// HAND-RAISE-FINGERPRINT-DEDUPE (11-26 23:xx · TC-H-POOL-2 sent 24 ✋ for one cause): the hand's model rewords the
// block every turn, so «same reason + same text» never matched. A ✋'s identity is what it waits on, not its prose:
// fingerprint = seat · reason · cause · the cell / refs named in it (ids like `TC-12`, `#40310`, `PR 40310` — sorted,
// case-folded). The same fingerprint again — even after a resume and a new turn — is a repeat: the open ✋ is reused
// (count · last seen), no new mail, no new card. It is forgotten when a rung replies, or after FINGERPRINT_TTL_MS.
// 출처: a working day of one seat — an unanswered cause older than this is a new conversation.
export const FINGERPRINT_TTL_MS = 6 * 60 * 60_000;

// The waited-on refs a ✋ text names (cell ids · mail/PR numbers) — one definition in kit/mail-route (also the ask identity).
export { waitedOnRefs };

/** Seat · reason · cause · waited-on refs — the ✋'s identity, insensitive to how the sentence is worded. */
export function handFingerprint(seat: string, reason: string, detail: string, cause?: string): string {
  const refs = waitedOnRefs(detail).filter((r) => r !== seat.toUpperCase());
  return `${seat.toUpperCase()}|${reason}|${cause ?? ''}|${refs.join(',')}`;
}

export function createNeedsHumanPush(deps: NeedsHumanDeps): NeedsHumanPush {
  let counter = 0;
  const newId = deps.newBlockId ?? (() => `blk-${Date.now().toString(36)}-${++counter}`);
  type Block = { blockId: string; reason: BlockReason; detail: string; cause?: HandCause; mailIds: Set<number>; rung: string; lastMailId: number | null; timer: unknown;
    fingerprint: string; count: number; firstAt: number; lastAt: number; routed?: string[]; ask?: string };
  let active: Block | null = null;
  /** Fingerprints with an open ✋ (posted, no reply yet) — survive a resume so a reworded repeat reuses the same ✋. */
  const open = new Map<string, Block>();
  /** Asks this process already answered by reference (ask → first row id): a re-block after that answer is a NEW ask
   *  («answer #N did not unblock»), never a second by-reference resume — no resume loop on a stale answer. */
  const referenced = new Map<string, number>();
  const nowMs = (): number => Date.now();
  let routingDone: Promise<void> = Promise.resolve();
  const log = (event: string, data: Record<string, unknown>): void => { try { deps.log?.(event, data); } catch { /* observation never breaks the turn */ } };

  const send = (seat: string, to: string, from: string | null, note?: string): boolean => {
    const block = active!;
    const line = block.detail || block.reason;
    const body = `[✋ NEED HUMAN · ${seat}] ${line} · 원하는 것: 이 막힘을 풀 결정·입력 (답장하면 그대로 재개) · 선택지: 재개/중단/다른 방법${note ? ` · ${note}` : ''}`;
    let id: number | undefined;
    let failure = 'postMail threw';
    try {
      id = deps.postMail({ from: seat, to, kind: 'request', intent: 'decision', body, correlationId: block.blockId,
        refs: [`block:${block.blockId}`, `seat:${seat}`, `pane:${deps.paneId()}`, `reason:${block.reason}`, ...(block.cause ? [`cause:${block.cause}`] : []), ...urgencyRef(block), ...(block.routed ?? []),
          ...(from === null && block.ask ? [block.ask] : [])] });
      if (!Number.isSafeInteger(id) || id! <= 0) { failure = 'postMail returned no valid message id'; throw new Error(failure); }
    } catch {
      log('seat.needs-human', { phase: 'route-failed', error: failure, rung: to, seat, blockId: block.blockId });
      return false;
    }
    block.mailIds.add(id!);
    block.rung = to;
    block.lastMailId = id!;
    log('seat.needs-human', { phase: from === null ? 'routed' : 'escalated', rung: to, ...(from === null ? {} : { from, to, ...(note?.includes('after 5m') ? { afterMs: ESCALATE_AFTER_MS } : {}) }), msgId: id, seat, blockId: block.blockId });
    return true;
  };
  const urgencyRef = (block: { reason: string; detail: string }): string[] => {
    let u: string = 'normal';
    try { u = deps.urgencyOf?.(block.reason, block.detail) ?? 'normal'; } catch { /* normal */ }
    return u === 'normal' ? [] : [`urgency:${u}`];
  };
  const toCeo = (seat: string): void => {
    const block = active!;
    block.rung = 'CEO';
    log('seat.needs-human', { phase: 'routed', rung: 'CEO', seat, blockId: block.blockId });
    try {
      deps.raiseDecision({ title: `[✋ NEED HUMAN · ${seat}] ${block.detail || block.reason}`, seat, reason: block.reason, blockId: block.blockId,
        summary: `${seat} is blocked and needs a person (${block.reason}). Choices: resume / stop / another way.` });
    } catch (error) { log('seat.needs-human', { phase: 'decision-raise-failed', error: String(error).slice(0, 160), seat }); }
  };
  // The rung's own mail was handled (its process acked / its turn took it in / it mailed the seat) → stop the ladder here.
  const handled = (seat: string): boolean => {
    const block = active!;
    const msgId = block.lastMailId;
    if (msgId === null || !deps.handledBy) return false;
    let by: NeedsHumanHandledBy | null = null;
    try { by = deps.handledBy({ msgId, rung: block.rung, seat }); }
    catch (error) { log('seat.needs-human', { phase: 'handled-check-failed', error: String(error).slice(0, 160), rung: block.rung, msgId, seat }); return false; }
    if (!by) return false;
    log('seat.needs-human', { phase: 'handled', rung: block.rung, by, msgId, seat, blockId: block.blockId });
    try { deps.ackFor?.(block.rung, msgId); }
    catch (error) { log('seat.needs-human', { phase: 'handled-ack-failed', error: String(error).slice(0, 160), rung: block.rung, msgId, seat }); }
    return true;
  };
  const arm = (seat: string): void => {
    const block = active!;
    block.timer = deps.setTimer(() => {
      if (active !== block) return;
      if (handled(seat)) return;
      const from = block.rung;
      if (from === 'OP' || seat === 'OP') {
        // The last mail rung went unanswered: a direction call (HUMAN_DECISION) reaches the CEO as a decision card.
        if (block.reason === 'HUMAN_DECISION' && from !== 'CEO') toCeo(seat);
        return;
      }
      // BEACON-LADDER (대표 11-25 21:1x «ONE path»): a hand never mails OP itself. The ✋ stays at its leader; the OP-scope
      // steward watcher (beaconHands) climbs for it on its own thresholds.
      log('seat.needs-human', { phase: 'held-at-leader', rung: from, seat, blockId: block.blockId });
    }, ESCALATE_AFTER_MS);
  };

  return {
    blocked(reason, detail, cause) {
      const seat = deps.seat();
      if (!seat) return;
      // The same block persisting (same code and same reason text, e.g. a mail-wake turn that ends still blocked): one mail per blockId.
      // A different reason text is a new block — it goes to the first rung again (05:57 TC-H-CX-1: a second block was swallowed
      // because only the code was compared while the first block, already escalated to OP, was never cleared).
      const fingerprint = handFingerprint(seat, reason, detail, cause);
      const t = nowMs();
      for (const [fp, b] of open) if (t - b.lastAt > FINGERPRINT_TTL_MS) open.delete(fp);
      // Same identity as the active ✋, or as an open one from an earlier turn: a repeat — count it, send nothing.
      const same = active && active.fingerprint === fingerprint ? active : open.get(fingerprint);
      if (same) {
        same.count += 1; same.lastAt = t;
        if (active !== same) { if (active) deps.clearTimer(active.timer); active = same; }
        log('seat.needs-human', { phase: 'repeat', seat, blockId: same.blockId, count: same.count, fingerprint, msgId: same.lastMailId });
        return;
      }
      if (active) { deps.clearTimer(active.timer); active = null; }
      active = { blockId: newId(), reason, detail, ...(cause ? { cause } : {}), mailIds: new Set(), rung: '', lastMailId: null, timer: null, fingerprint, count: 1, firstAt: t, lastAt: t };
      open.set(fingerprint, active);
      const coordinator = deps.coordinatorOf();
      const defaultFirst = coordinator && coordinator !== seat ? coordinator : seat === 'OP' ? 'CEO' : 'OP';
      if (defaultFirst === 'CEO') { toCeo(seat); return; }
      // KIT mail-route hand-route — the first rung is the owner of the block's root when OP/TC would only forward it
      // (WIP handover → TC ⊕ the WIP takeover rule · JUD verdict → JUDGE-BUTLER · env/host/lease → GUARDIAN). Structured
      // codes decide at once; an unstructured line asks Jev once (async) — unavailable/unclear → old rung.
      const block = active;
      const cell = (() => { try { return deps.cellOf?.(seat) ?? null; } catch { return null; } })();
      const input = { seat, defaultTo: defaultFirst, reason, detail, cause: cause ?? null, cell };
      const ropts = deps.cellOwnerOf ? { cellOwnerOf: deps.cellOwnerOf } : undefined;
      const deliver = (classification: HandClassification): void => {
        if (active !== block) return; // resumed or replaced while the classifier was thinking
        const route = routeHandBlock(input, classification, ropts);
        if (route.rerouted) {
          block.routed = [`hand-root:${route.root}`, `hand-routed-from:${defaultFirst}`];
          log('seat.needs-human', { phase: 'hand-route', seat, blockId: block.blockId, root: route.root, by: route.by, rung: route.to, from: defaultFirst });
        }
        // HAND-RAISE-DOMAIN-ROUTING — the ask identity: the post layer folds the same ask inside 30 min into its first row.
        const ask = handAskRef(route.root, handAskCell({ seat, claimed: cell, detail, isCell: deps.cellOwnerOf ? (id) => deps.cellOwnerOf!(id) !== null : null }));
        const stale = referenced.get(ask);
        block.ask = stale === undefined ? ask : `${ask}:after-${stale}`;
        const note = [route.attach, stale === undefined ? undefined : `answer #${stale} did not unblock`].filter(Boolean).join(' · ') || undefined;
        if (send(seat, route.to, null, note)) {
          // The same ask was already answered (the post returned that first row): resume with its answer by reference.
          const first = block.lastMailId;
          let answer: string | null = null;
          if (first !== null && deps.answerOf) { try { answer = deps.answerOf(first, seat); } catch { answer = null; } }
          if (answer !== null && first !== null && stale === undefined) {
            referenced.set(ask, first);
            deps.clearTimer(block.timer);
            active = null;
            open.delete(block.fingerprint);
            log('seat.needs-human', { phase: 'answered-by-reference', seat, blockId: block.blockId, msgId: first, ask: block.ask });
            deps.resumeWith(`[✋ answered by reference #${first}] ${answer}`);
            return;
          }
          arm(seat);
          return;
        }
        // Delivery to the leader failed (no ledger row for the watcher to see): the CEO card is the only rung left.
        toCeo(seat);
      };
      const structured = classifyHandBlock(input, ropts);
      if (!deps.classifyHand || !handNeedsClassifier(input, ropts)) { routingDone = Promise.resolve(); deliver(structured); return; }
      routingDone = resolveHandRoot(input, deps.classifyHand, ropts).then((c) => {
        log('seat.needs-human', { phase: 'hand-classify', seat, blockId: block.blockId, root: c.root, by: c.by });
        deliver(c);
      }, () => deliver(structured));
    },
    resumed() {
      if (!active) return;
      deps.clearTimer(active.timer);
      active = null;
    },
    noteArrivals(arrivals) {
      const block = active;
      // A reply to an earlier ✋ of this seat that is no longer active still closes its fingerprint.
      if (arrivals) for (const [fp, b] of open) if (b !== block && arrivals.some((a) => a.replyTo !== undefined && b.mailIds.has(a.replyTo))) open.delete(fp);
      if (!block || !arrivals) return false;
      const hit = arrivals.find((a) => a.replyTo !== undefined && block.mailIds.has(a.replyTo));
      if (!hit) return false;
      deps.clearTimer(block.timer);
      active = null;
      open.delete(block.fingerprint); // answered: the same cause later is a new ✋
      log('seat.needs-human', { phase: 'resumed-by-reply', rung: block.rung, blockId: block.blockId, replyTo: hit.replyTo });
      deps.resumeWith(hit.text);
      return true;
    },
    activeBlockId: () => active?.blockId ?? null,
    routing: () => routingDone,
  };
}
