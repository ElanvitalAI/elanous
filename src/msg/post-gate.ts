/**
 * MAIL-ANTI-FLOOD — the one gate both sender entrances (CLI `msg post` · MsgPost tool) run before a row is written.
 * E shape → F destination → G back-pressure. Pure decision ⊕ injected side effects (tests and the sim use the same code).
 * Policy tables: `post-discipline.ts` · side ledgers: `diverted-mail.ts`.
 */
import { debug } from '../debug/log.js';
import { assessSeatSurge, SEAT_SURGE_WINDOW_MS, type SeatSurgeEvent } from './seat-surge-monitor.js';
import type { MessageEnvelope } from './msg-store.js';
import {
  backpressureConfigFrom, backpressureVerdict, proxyLaneEligible, postKindlessWarning, BACKPRESSURE_DEFAULTS, foldedLine, isUrgentPost, postDestination, resolvePostShape,
  type BackpressureConfig, type MsgPostKind, type PostEntrance, type PostShapeRule,
} from './post-discipline.js';
import { appendDiverted, divertedRoot, divertedSendersSince, pendingDiverted, turnsLastHour, type DivertedEntry, type DivertedLedger } from './diverted-mail.js';
import { answersReceiverAsk, ledgerDelegationFacts, type DelegationFacts } from './delegation-facts.js';
import { floodExempt } from '../tui/seat-mail-flood.js';
import { cancelProxyLane, commitProxyLane, isProxySeat, PROXY_LANE_PER_HOUR, proxyBodyHash, proxyLaneLine, proxyLaneVerdict, reserveProxyLane, PROXY_LANE_REF, type ProxyLaneVerdict } from './proxy-lane.js';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface PostGateDeps {
  /** Receiver's unacked passive mail ⊕ unread folded entries. */
  pendingPassive(to: string): number;
  /** Receiver's MAIL-OPENED turns in the last hour (null = unknown · self-wakes and goal-drive turns excluded). */
  turnsLastHour(to: string): number | null;
  /** THROTTLE-AUDIT — distinct seats that wrote to the receiver in the last hour (null/absent = unknown → floor only). */
  correspondentsLastHour?(to: string): number | null;
  pairLoop?(from: string, to: string, now: number): boolean;
  /** RAIL30 ① — ledger delegation facts: a reply to the receiver's own ask always passes G. Absent = unknown (no). */
  delegation?: DelegationFacts;
  config?: BackpressureConfig;
  /**
   * CLAUDE-OP-PROXY-LANE — judge ⊕ reserve one lane slot atomically; `cancel` releases it when the row is not written.
   * Absent = no budget ledger (the verdict runs on an empty history · the lane still routes).
   */
  proxyLane?: {
    reserve(to: string, post: { hash: string; answer: boolean }, nowMs: number): { verdict: ProxyLaneVerdict; token?: string };
    cancel(to: string, token: string): void;
    commit(to: string, token: string): void;
  };
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
  /** CLAUDE-OP-PROXY-LANE — the sender's proxy identity: true verified · false checked and not verified · undefined unchecked. */
  proxyVerified?: boolean;
}

export interface GateShape { kind: string; cls: MsgPostKind; needsReply: boolean; rule: PostShapeRule }

export type PostGateOutcome =
  | { action: 'refuse'; error: string }
  | { action: 'post'; envelope: MessageEnvelope; shape: GateShape; urgent: boolean; warning?: string; lane?: string;
      /** CLAUDE-OP-PROXY-LANE — release the reserved lane slot when the row is NOT written (call only on a failed store). */
      laneCancel?: () => void;
      /** CLAUDE-OP-PROXY-LANE — confirm the reserved slot once the row IS written (an uncommitted slot lapses in 30 s). */
      laneCommit?: () => void }
  | { action: 'divert'; ledger: DivertedLedger; line: string; shape: GateShape; urgent: boolean };

const isSeatAddress = (to: string): boolean => to !== 'ALL' && !to.startsWith('group:');

export function gatePost(input: PostGateInput, deps: PostGateDeps): PostGateOutcome {
  // CLAUDE-OP-PROXY-LANE — the lane ref is stamped only by this gate: a sender-written one is dropped.
  const env0 = input.envelope;
  const env: MessageEnvelope = env0.refs?.includes(PROXY_LANE_REF) ? { ...env0, refs: env0.refs.filter((r) => r !== PROXY_LANE_REF) } : env0;
  const log = deps.log ?? ((event, data) => { try { debug.log('msg', event, data); } catch { /* fail-open */ } });
  const shapeIn = {
    from: env.from, to: env.to, kind: env.kind ?? null, needsReply: input.needsReply ?? (env.needsAck ?? null), intent: env.intent ?? null,
    replyTo: env.replyTo ?? null, refs: env.refs ?? null, crownDirective: env.crownDirective ?? null, priority: env.priority ?? null,
    origin: env.origin ?? null, doneWhen: env.doneWhen ?? null, deadlineAt: env.deadlineAt ?? null, ...(input.senderAbove === undefined ? {} : { senderAbove: input.senderAbove }),
    ...(input.proxyVerified === undefined ? {} : { proxyVerified: input.proxyVerified }),
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
  let dest = postDestination({ ...shapeIn, cls: shape.cls, needsReply: shape.needsReply, ...(answersAsk ? { answersReceiverAsk: true } : {}) });
  // CLAUDE-OP-PROXY-LANE — a proxy post of a lane kind is mail on the lane: own budget (answers outside it) ⊕ dedupe.
  let lane: { refs: string[]; line: string; cancel: () => void; commit: () => void } | null = null;
  if (dest === 'mailbox' && isSeatAddress(env.to) && !env.crownDirective && proxyLaneEligible(shapeIn)) {
    const hash = proxyBodyHash(env.body);
    let reserved: { verdict: ProxyLaneVerdict; token?: string };
    try { reserved = deps.proxyLane ? deps.proxyLane.reserve(env.to, { hash, answer: answersAsk }, now.getTime()) : { verdict: proxyLaneVerdict([], { hash, answer: answersAsk }, now.getTime()) }; }
    catch (error) {
      // The ledger is a meter: an unreadable/locked ledger lets the post through unmetered (logged) rather than lose it.
      log('msg.proxy-lane.ledger-failed', { to: env.to, error: String(error).slice(0, 160) });
      reserved = { verdict: { verdict: 'pass', used: 0 } };
    }
    const verdict = reserved.verdict;
    log('msg.proxy-lane', { from: env.from, to: env.to, verdict: verdict.verdict, kind: shape.kind, ...(answersAsk ? { answer: true } : {}) });
    if (verdict.verdict === 'duplicate') return { action: 'refuse', error: proxyLaneLine(env.to, verdict) };
    if (verdict.verdict === 'over-budget') dest = 'coach-note';
    else {
      const token = reserved.token;
      const to = env.to;
      lane = { refs: [...(env.refs ?? []), PROXY_LANE_REF], line: proxyLaneLine(env.to, verdict),
        cancel: () => { if (token && deps.proxyLane) { try { deps.proxyLane.cancel(to, token); } catch { /* an uncommitted slot lapses after the pending window */ } } },
        commit: () => { if (token && deps.proxyLane) { try { deps.proxyLane.commit(to, token); } catch { /* an uncommitted slot lapses: budget/dedupe under-count, mail is never lost */ } } } };
    }
  }
  if (dest !== 'mailbox') {
    try {
      append(dest, entry(env.to));
      log('msg.post.diverted', { from: env.from, to: env.to, ledger: dest });
      return { action: 'divert', ledger: dest, shape, urgent,
        line: dest === 'self-wake' ? `self-mail → scheduled wake for ${env.to} (not a mailbox row)`
          : isProxySeat(env.from) && proxyLaneEligible(shapeIn) ? `${proxyLaneLine(env.to, { verdict: 'over-budget', used: PROXY_LANE_PER_HOUR })}`
          : `coach injection → coach note for ${env.to} (one line per 30 min in its next turn · not mail)` };
    } catch (error) { log('msg.post.divert-failed', { from: env.from, to: env.to, ledger: dest, error: String(error).slice(0, 160) }); }
  }
  // Preserve urgent and actionable messages; fold only passive chatter from a looping pair.
  if (dest === 'mailbox' && lane === null && !urgent && isSeatAddress(env.to) && env.from !== env.to) {
    try {
      if (deps.pairLoop?.(env.from, env.to, now.getTime())) {
        append('folded', entry(env.to));
        log('msg.pair-loop.folded', { from: env.from, to: env.to });
        return { action: 'divert', ledger: 'folded', shape, urgent, line: `pair loop → folded digest for ${env.to}` };
      }
    } catch (error) { log('msg.pair-loop.failed', { error: String(error).slice(0, 160) }); }
  }
  // G — back-pressure on a saturated seat receiver (a proxy lane post has its own budget above).
  if (isSeatAddress(env.to) && !urgent && lane === null) {
    let correspondents: number | null = null;
    try { correspondents = deps.correspondentsLastHour ? deps.correspondentsLastHour(env.to) : null; } catch { correspondents = null; }
    const verdict = backpressureVerdict({ urgent, pendingPassive: deps.pendingPassive(env.to), turnsLastHour: deps.turnsLastHour(env.to), correspondentsLastHour: correspondents }, deps.config ?? BACKPRESSURE_DEFAULTS);
    if (verdict.fold) {
      try {
        append('folded', entry(env.to));
        log('msg.backpressure', { to: env.to, folded: 1, from: env.from, reason: verdict.reason, ...(correspondents === null ? {} : { correspondents }) });
        return { action: 'divert', ledger: 'folded', shape, urgent, line: foldedLine(env.to, verdict.reason) };
      } catch (error) { log('msg.backpressure.fold-failed', { to: env.to, error: String(error).slice(0, 160) }); }
    }
  }
  const envelope: MessageEnvelope = { ...env, kind: shape.kind, ...(input.entrance === 'legacy' ? {} : { needsAck: shape.needsReply }), ...(lane ? { refs: lane.refs } : {}) };
  return { action: 'post', envelope, shape, urgent: urgent || lane !== null, ...(lane ? { lane: lane.line, laneCancel: lane.cancel, laneCommit: lane.commit } : {}), ...(shape.rule === 'kindless' ? { warning: postKindlessWarning() } : {}) };
}

/** The receiver-load probes on a real ledger: unacked passive rows ⊕ unread folded entries · turn stamps. */
export function storeGateDeps(store: { unreadCount(to: string): number; actionableUnreadCount(to: string): number; db?: Parameters<typeof ledgerDelegationFacts>[0] }, root: string = divertedRoot()): PostGateDeps {
  return {
    ...(store.db ? { delegation: ledgerDelegationFacts(store.db), pairLoop: (from: string, to: string, now: number) => {
      const rows = store.db!.query(`SELECT sender, recipient, created_at FROM msg_messages WHERE ((sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?)) AND created_at >= ? AND created_at <= ? ORDER BY created_at, id`)
        .all(from, to, to, from, new Date(now - SEAT_SURGE_WINDOW_MS).toISOString(), new Date(now).toISOString()) as Array<{ sender: string; recipient: string; created_at: string }>;
      const events: SeatSurgeEvent[] = rows.map((r) => ({ type: 'mail', from: r.sender, to: r.recipient, at: Date.parse(r.created_at) }));
      return assessSeatSurge(from, events, now).triggers.includes(`ping-pong:${to.trim().toUpperCase()}`);
    } } : {}),
    pendingPassive: (to) => {
      let rows = 0;
      try { rows = Math.max(0, store.unreadCount(to) - store.actionableUnreadCount(to)); } catch { rows = 0; }
      let folded = 0;
      try { folded = pendingDiverted('folded', to, root).length; } catch { folded = 0; }
      return rows + folded;
    },
    turnsLastHour: (to) => { try { return turnsLastHour(to, Date.now(), root); } catch { return null; } },
    ...(store.db ? { correspondentsLastHour: (to: string) => correspondentsLastHour(store.db!, to, Date.now(), root) } : {}),
    config: readBackpressureConfig(root),
    proxyLane: { reserve: (to, post, nowMs) => reserveProxyLane(root, to, post, nowMs), cancel: (to, token) => cancelProxyLane(root, to, token), commit: (to, token) => commitProxyLane(root, to, token) },
    append: (ledger, entry) => appendDiverted(ledger, entry, root),
  };
}

/**
 * THROTTLE-AUDIT — distinct seats (not the receiver itself) that wrote to `to` in the hour before `nowMs`: mailbox rows ⊕
 * posts already folded/diverted to it (a folded sender still counts, so folding never shrinks the ceiling). Throws → caller null.
 */
export function correspondentsLastHour(db: { query(sql: string): { all(...params: unknown[]): unknown[] } }, to: string, nowMs: number, root: string = divertedRoot()): number {
  const id = to.trim().toUpperCase();
  const since = nowMs - 60 * 60_000;
  const rows = db.query('SELECT DISTINCT sender FROM msg_messages WHERE recipient = ? AND created_at >= ?').all(id, new Date(since).toISOString()) as { sender?: string }[];
  const seats = new Set(rows.map((r) => String(r.sender ?? '').trim().toUpperCase()).filter(Boolean));
  for (const s of divertedSendersSince('folded', to, since, root)) seats.add(s);
  seats.delete(id);
  return seats.size;
}

/** G config — `<state>/msg/diverted/backpressure.json` {maxPendingPassive, maxTurnsPerHour, turnsPerCorrespondent}; absent = code defaults (30 · 20 · 2). */
export function readBackpressureConfig(root: string = divertedRoot()): BackpressureConfig {
  const file = join(root, 'backpressure.json');
  if (!existsSync(file)) return BACKPRESSURE_DEFAULTS;
  try { return backpressureConfigFrom(JSON.parse(readFileSync(file, 'utf8'))); } catch { return BACKPRESSURE_DEFAULTS; }
}

/** The diverted ledgers live next to the mail ledger they divert from (`<msg dir>/diverted`). */
export function divertedRootForStore(storePath: string | undefined): string {
  return storePath === undefined || storePath === ':memory:' ? divertedRoot() : join(dirname(storePath), 'diverted');
}
