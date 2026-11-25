/**
 * MAIL-ANTI-FLOOD — the one gate both sender entrances (CLI `msg post` · MsgPost tool) run before a row is written.
 * E shape → F destination → G back-pressure. Pure decision ⊕ injected side effects (tests and the sim use the same code).
 * Policy tables: `post-discipline.ts` · side ledgers: `diverted-mail.ts`.
 */
import { debug } from '../debug/log.js';
import type { MessageEnvelope } from './msg-store.js';
import {
  backpressureConfigFrom, backpressureVerdict, postKindlessWarning, BACKPRESSURE_DEFAULTS, foldedLine, isUrgentPost, postDestination, resolvePostShape,
  type BackpressureConfig, type MsgPostKind, type PostEntrance, type PostShapeRule,
} from './post-discipline.js';
import { appendDiverted, divertedRoot, pendingDiverted, turnsLastHour, type DivertedEntry, type DivertedLedger } from './diverted-mail.js';
import { answersReceiverAsk, ledgerDelegationFacts, type DelegationFacts } from './delegation-facts.js';
import { floodExempt } from '../tui/seat-mail-flood.js';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface PostGateDeps {
  /** Receiver's unacked passive mail ⊕ unread folded entries. */
  pendingPassive(to: string): number;
  /** Receiver's MAIL-OPENED turns in the last hour (null = unknown · self-wakes and goal-drive turns excluded). */
  turnsLastHour(to: string): number | null;
  /** RAIL30 ① — ledger delegation facts: a reply to the receiver's own ask always passes G. Absent = unknown (no). */
  delegation?: DelegationFacts;
  config?: BackpressureConfig;
  append?: (ledger: DivertedLedger, entry: DivertedEntry) => void;
  now?: () => Date;
  log?: (event: string, data: Record<string, unknown>) => void;
}

export interface PostGateInput {
  envelope: MessageEnvelope;
  /** E — the sender's needsReply (CLI --needs-reply/--no-needs-reply · tool needsReply). */
  needsReply?: boolean | null;
  entrance: PostEntrance;
  senderAbove?: boolean;
}

export interface GateShape { kind: string; cls: MsgPostKind; needsReply: boolean; rule: PostShapeRule }

export type PostGateOutcome =
  | { action: 'refuse'; error: string }
  | { action: 'post'; envelope: MessageEnvelope; shape: GateShape; urgent: boolean; warning?: string }
  | { action: 'divert'; ledger: DivertedLedger; line: string; shape: GateShape; urgent: boolean };

const isSeatAddress = (to: string): boolean => to !== 'ALL' && !to.startsWith('group:');

export function gatePost(input: PostGateInput, deps: PostGateDeps): PostGateOutcome {
  const env = input.envelope;
  const log = deps.log ?? ((event, data) => { try { debug.log('msg', event, data); } catch { /* fail-open */ } });
  const shapeIn = {
    from: env.from, to: env.to, kind: env.kind ?? null, needsReply: input.needsReply ?? (env.needsAck ?? null), intent: env.intent ?? null,
    replyTo: env.replyTo ?? null, refs: env.refs ?? null, crownDirective: env.crownDirective ?? null, priority: env.priority ?? null,
    origin: env.origin ?? null, doneWhen: env.doneWhen ?? null, deadlineAt: env.deadlineAt ?? null, ...(input.senderAbove === undefined ? {} : { senderAbove: input.senderAbove }),
  };
  const resolved = resolvePostShape(shapeIn, input.entrance);
  if (!resolved.ok) { log('msg.post.refused', { from: env.from, to: env.to, entrance: input.entrance }); return { action: 'refuse', error: resolved.error }; }
  const shape: GateShape = { kind: resolved.kind, cls: resolved.cls, needsReply: resolved.needsReply, rule: resolved.rule };
  // RAIL30 ① — a result answering the receiver's own ask (replyTo its mail · result/pr/receipt for its cell) is urgent.
  const answersAsk = isSeatAddress(env.to) && answersReceiverAsk(deps.delegation, { to: env.to, replyTo: env.replyTo ?? null, refs: env.refs ?? null });
  // RAIL30 ② — G never folds what Q9's flood rule would let through (crown · human · ✋ · alert · P0): one owner each.
  const urgent = isUrgentPost({ ...shapeIn, cls: shape.cls, needsReply: shape.needsReply, ...(answersAsk ? { answersReceiverAsk: true } : {}) })
    || floodExempt({ crownDirective: env.crownDirective ?? null, origin: env.origin ?? null, kind: shape.kind, intent: env.intent ?? null, priority: env.priority ?? null });
  if (shape.rule === 'kindless') log('msg.kindless', { from: env.from, to: env.to });
  log('msg.post.shape', { from: env.from, to: env.to, kind: shape.kind, needsReply: shape.needsReply, rule: shape.rule, entrance: input.entrance, ...(answersAsk ? { answersAsk: true } : {}) });
  const now = (deps.now ?? (() => new Date()))();
  const append = deps.append ?? ((ledger: DivertedLedger, entry: DivertedEntry) => appendDiverted(ledger, entry));
  const entry = (seat: string): DivertedEntry => ({ seat, from: env.from, kind: shape.kind, body: env.body, at: now.toISOString(), ...(env.refs?.length ? { refs: [...env.refs] } : {}) });
  // F — self-mail / coach injection leave the mailbox (a failed append keeps it as mail: nothing is dropped).
  const dest = postDestination({ ...shapeIn, needsReply: shape.needsReply });
  if (dest !== 'mailbox') {
    try {
      append(dest, entry(env.to));
      log('msg.post.diverted', { from: env.from, to: env.to, ledger: dest });
      return { action: 'divert', ledger: dest, shape, urgent,
        line: dest === 'self-wake' ? `self-mail → scheduled wake for ${env.to} (not a mailbox row)` : `coach injection → coach note for ${env.to} (one line per 30 min in its next turn · not mail)` };
    } catch (error) { log('msg.post.divert-failed', { from: env.from, to: env.to, ledger: dest, error: String(error).slice(0, 160) }); }
  }
  // G — back-pressure on a saturated seat receiver.
  if (isSeatAddress(env.to) && !urgent) {
    const verdict = backpressureVerdict({ urgent, pendingPassive: deps.pendingPassive(env.to), turnsLastHour: deps.turnsLastHour(env.to) }, deps.config ?? BACKPRESSURE_DEFAULTS);
    if (verdict.fold) {
      try {
        append('folded', entry(env.to));
        log('msg.backpressure', { to: env.to, folded: 1, from: env.from, reason: verdict.reason });
        return { action: 'divert', ledger: 'folded', shape, urgent, line: foldedLine(env.to, verdict.reason) };
      } catch (error) { log('msg.backpressure.fold-failed', { to: env.to, error: String(error).slice(0, 160) }); }
    }
  }
  const envelope: MessageEnvelope = { ...env, kind: shape.kind, ...(input.entrance === 'legacy' ? {} : { needsAck: shape.needsReply }) };
  return { action: 'post', envelope, shape, urgent, ...(shape.rule === 'kindless' ? { warning: postKindlessWarning() } : {}) };
}

/** The receiver-load probes on a real ledger: unacked passive rows ⊕ unread folded entries · turn stamps. */
export function storeGateDeps(store: { unreadCount(to: string): number; actionableUnreadCount(to: string): number; db?: Parameters<typeof ledgerDelegationFacts>[0] }, root: string = divertedRoot()): PostGateDeps {
  return {
    ...(store.db ? { delegation: ledgerDelegationFacts(store.db) } : {}),
    pendingPassive: (to) => {
      let rows = 0;
      try { rows = Math.max(0, store.unreadCount(to) - store.actionableUnreadCount(to)); } catch { rows = 0; }
      let folded = 0;
      try { folded = pendingDiverted('folded', to, root).length; } catch { folded = 0; }
      return rows + folded;
    },
    turnsLastHour: (to) => { try { return turnsLastHour(to, Date.now(), root); } catch { return null; } },
    config: readBackpressureConfig(root),
    append: (ledger, entry) => appendDiverted(ledger, entry, root),
  };
}

/** G config — `<state>/msg/diverted/backpressure.json` {maxPendingPassive, maxTurnsPerHour}; absent = code defaults (30 · 20). */
export function readBackpressureConfig(root: string = divertedRoot()): BackpressureConfig {
  const file = join(root, 'backpressure.json');
  if (!existsSync(file)) return BACKPRESSURE_DEFAULTS;
  try { return backpressureConfigFrom(JSON.parse(readFileSync(file, 'utf8'))); } catch { return BACKPRESSURE_DEFAULTS; }
}

/** The diverted ledgers live next to the mail ledger they divert from (`<msg dir>/diverted`). */
export function divertedRootForStore(storePath: string | undefined): string {
  return storePath === undefined || storePath === ':memory:' ? divertedRoot() : join(dirname(storePath), 'diverted');
}
