// OP-REQUIREMENT-LOOP — the turn-end adapter: gather structured inputs, decide, open ONE continuation through the
// existing internal-turn door, persist. entry.ts stays a hook; every read is fail-soft (a gather error never blocks
// a turn end, it only seeds less).
import type { StartTurnIfIdleOptions, StartTurnIfIdleResult } from '../chat/internal-turn-contract.js';
import { debug } from '../debug/log.js';
import {
  decideTurnEnd, markStale, noteContinuationOpened, readStore, requirementStorePath, routeBlocked, seedRequirements, migrateUnreferencedDirectives, writeStore,
  type Requirement, type SeedInput, type WaitFor, type WaitState,
} from './requirement-loop.js';
import { boardVersion } from '../release-loop/board-version.js';

export const REQUIREMENT_LOOP_SEAT = 'OP';
const CATEGORY = 'op.requirements';

export interface RequirementTurnEndDeps {
  seat: string | null;
  /** This turn's text when its structured source is a person (`from.kind === 'human'`), else null. */
  /** A person's line in the seat (typed · TG-OP) — always a requirement (R ⓐ); `human: false` = a crown-flagged relayed mail. */
  humanTurn: { turnId: string; text: string; refs?: readonly string[]; kind?: string | null; announce?: boolean; human?: boolean } | null;
  startTurnIfIdle: (text: string, opts: StartTurnIfIdleOptions) => StartTurnIfIdleResult;
  notify?: (line: string) => void;
  now?: () => Date;
  stateRoot?: () => string;
  /** Test seam: replaces the checklist/commitment/waker reads. */
  gather?: () => Promise<{ seed: SeedInput; waitState: (r: Requirement) => WaitState }>;
  log?: (category: string, event: string, data: Record<string, unknown>) => void;
  /**
   * REQ-BLOCK-ROUTE-TO-ASKEE — a CEO card for a BLOCKED requirement, ONLY when routeBlocked says `ceo-card` (a CEO line with a
   * CEO-only gap). Returns the card id. Default: DecisionLedger.raiseOnce (ref req-blocked:<id>) with filled S/C/Q/A ⊕ a recommendation.
   */
  raiseException?: (r: Requirement, line: string, gap: string) => string | undefined;
  /** Posts one mail (re-ask · exception line). Returns the message id. Default: the mail store, from = the seat. */
  postMail?: (mail: { to: string; kind: 'question' | 'exception'; body: string; refs: string[] }) => number | undefined;
  /** The coordinator seat above a seat (undefined = none known). Default: federation leadership → the seat itself for a leader, else OP. */
  coordinatorOf?: (seat: string) => string | undefined;
}

function defaultRaiseException(seat: string, r: Requirement, line: string, gap: string): string | undefined {
  const { DecisionLedger } = require('../decisions/decision-ledger.js') as typeof import('../decisions/decision-ledger.js');
  const ref = `req-blocked:${r.id}`;
  const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);
  const category = gap === 'policy' ? 'scope' : gap === 'irreversible' ? 'irreversible' : gap === 'money' ? 'money' : 'security';
  return new DecisionLedger().raiseOnce({
    title: clip(`[${seat} · ${gap} decision] ${r.title}`, 140), category,
    scqa: {
      s: clip(`CEO line: ${r.title}`, 230),
      c: clip(`${seat} cannot close it without a ${gap} decision`, 230),
      q: clip(`Approve the ${gap} step needed to close it?`, 230),
      a: clip(`Approve lets ${seat} finish: ${r.closeCondition}`, 230),
    },
    options: [
      { key: 'a', label: 'Approve', consequence: `${seat} carries out the ${gap} step and closes it with evidence` },
      { key: 'b', label: 'Hold', consequence: `${seat} stops the item and records why` },
    ],
    recommendation: { option: 'b', why: `a ${gap} step is not taken without an explicit approval` },
    raisedBy: { agent: `requirements:${seat}` }, refs: [ref, `seat:${seat}`, `gap:${gap}`, 'origin:ceo'],
    pendingQuestion: clip(line, 500),
  }, ref).id;
}

function defaultPostMail(seat: string): NonNullable<RequirementTurnEndDeps['postMail']> {
  return (mail) => {
    const { openMsgStore } = require('../msg/msg-store.js') as typeof import('../msg/msg-store.js');
    return openMsgStore().post({ from: seat, to: mail.to, kind: mail.kind, body: mail.body, refs: mail.refs }, { dedupe: true }).id;
  };
}

function defaultCoordinatorOf(seat: string): string | undefined {
  try {
    const { liveSeatLeadership } = require('../seat/seat-leadership.js') as typeof import('../seat/seat-leadership.js');
    // A space lead / kingdom seat is its own coordinator; any other seat answers to HQ (OP) — which routeBlocked treats as «no one above».
    return liveSeatLeadership(seat)?.seat ?? 'OP';
  } catch { return undefined; }
}

/** `mail-reply:<id>` (the structured waker grammar, self-timer-watch.ts) → [id]; any other condition → []. */
export function mailReplyId(condition: string | undefined): number[] {
  if (!condition || !condition.startsWith('mail-reply:')) return [];
  const id = Number(condition.slice('mail-reply:'.length).trim().replace(/^#/, ''));
  return Number.isSafeInteger(id) && id > 0 ? [id] : [];
}

async function defaultStateRoot(): Promise<string> {
  const { elanousStateRoot } = await import('../autopilot/state-paths.js');
  return elanousStateRoot();
}

/** Recipient seat of a delegated mail, read from the mail store (read-only, fail-soft → undefined). */
async function mailRecipients(): Promise<(msgId: string) => string | undefined> {
  try {
    const { openMsgStoreReadOnly } = await import('../msg/msg-store.js');
    const store = openMsgStoreReadOnly();
    return (msgId) => {
      try { return store.getMessage(Number(msgId))?.to ?? undefined; } catch { return undefined; }
    };
  } catch (error) {
    debug.log(CATEGORY, 'gather-failed', { source: 'mail-store', error: String(error).slice(0, 200) });
    return () => undefined;
  }
}

/** P0 cells of the current release owned by OP ⊕ OP's open follow-up commitments bound to a waker. */
async function defaultGather(seat: string): Promise<{ seed: SeedInput; waitState: (r: Requirement) => WaitState }> {
  const seed: SeedInput = {};
  try {
    const { listChecklist, ownerMatches } = await import('../release-loop/checklist.js');
    const { releaseLedgerRoot } = await import('../instance/resolve.js');
    const version = boardVersion();
    seed.p0Cells = listChecklist(version, releaseLedgerRoot()).items
      .filter((item) => item.priority === 'P0' && ownerMatches(item.owner, seat))
      .map((item) => ({ version, id: item.id, title: item.title, status: item.status, ...(item.owner ? { owner: item.owner } : {}) }));
  } catch (error) { debug.log(CATEGORY, 'gather-failed', { source: 'checklist', error: String(error).slice(0, 200) }); }
  const wakerStatus = new Map<string, { status: WaitState; wait: WaitFor }>();
  try {
    const { CommitmentLedger } = await import('../commitment/ledger.js');
    const { listWakers } = await import('../msg/self-timer-watch.js');
    for (const w of listWakers(seat)) {
      // Later records win: a re-armed waker replaces a fired or expired one.
      wakerStatus.set(w.commitmentId, { status: w.status === 'cancelled' ? 'none' : w.status, wait: { commitmentId: w.commitmentId, condition: w.condition, deadlineAt: w.deadlineAt } });
    }
    const peerOf = await mailRecipients();
    seed.delegated = new CommitmentLedger().list(seat, { status: ['open', 'done'] })
      .filter((c) => c.sessionId.startsWith('msg:') && c.wakers.length > 0)
      .map((c) => {
        const msgId = c.sessionId.slice('msg:'.length);
        const peer = peerOf(msgId);
        return { commitmentId: c.id, msgId, text: c.text, status: c.status, ...(peer ? { peer } : {}),
          ...(c.doneEvidence ? { doneEvidence: c.doneEvidence } : {}), ...(wakerStatus.get(c.id) ? { wait: wakerStatus.get(c.id)!.wait } : {}) };
      });
  } catch (error) { debug.log(CATEGORY, 'gather-failed', { source: 'commitments', error: String(error).slice(0, 200) }); }
  return { seed, waitState: (r) => (r.waitFor ? wakerStatus.get(r.waitFor.commitmentId)?.status ?? 'none' : 'none') };
}

/**
 * Returns whether a continuation turn was opened. Only the OP seat has a requirement loop.
 * QUEUE-FINISH-FIRST: `pending` = a continuation was due (an open requirement the seat is working on) whether or not
 * the door opened it now — the entry queue holds ordinary mail while it is true. `waitingReplyTo` = the mail ids the
 * open requirements wait on (`mail-reply:<id>` waits) — a reply to one of them joins the current work.
 */
export async function runRequirementTurnEnd(deps: RequirementTurnEndDeps): Promise<{ opened: boolean; reason: string; pending?: boolean; waitingReplyTo?: number[] }> {
  if (deps.seat !== REQUIREMENT_LOOP_SEAT) return { opened: false, reason: 'not-op' };
  const log = deps.log ?? ((c, e, d) => debug.log(c, e, d));
  const now = (deps.now ?? (() => new Date()))();
  const path = requirementStorePath(deps.stateRoot ? deps.stateRoot() : await defaultStateRoot(), deps.seat);
  const store = readStore(path);
  // R ④ — CEO requirements stored before this build with no evidence refs close as «superseded: pre-unify migration» (one digest line).
  const migrated = migrateUnreferencedDirectives(store, now.toISOString());
  if (migrated.length) {
    log(CATEGORY, 'superseded-pre-unify', { requirementIds: migrated, count: migrated.length });
    deps.notify?.(`requirements: ${migrated.length} pre-unify CEO item(s) without cell/PR/metric refs closed as superseded (pre-unify migration)`);
  }
  const gathered = await (deps.gather ?? (() => defaultGather(deps.seat!)))();
  seedRequirements(store, { ...gathered.seed, ...(deps.humanTurn ? { directives: [{ human: true, ...deps.humanTurn }] } : {}) }, now.toISOString());
  const decision = decideTurnEnd(store, { now, waitState: gathered.waitState });
  if (decision.escalated.length) log(CATEGORY, 'escalated', { requirementIds: decision.escalated, count: decision.escalated.length });
  for (const e of decision.expired) log(CATEGORY, 'expired', { requirementId: e.requirementId, line: e.line });
  for (const b of decision.blocked) log(CATEGORY, 'blocked', { requirementId: b.requirementId, code: 'SAME_GAP' });
  routeBlockedRequirements(store, decision.blocked, deps, now, log);
  const waitingReplyTo = store.requirements
    .filter((r) => r.status === 'open' || r.status === 'blocked')
    .flatMap((r) => mailReplyId(r.waitFor?.condition));
  let result: { opened: boolean; reason: string; pending?: boolean; waitingReplyTo?: number[] } = {
    opened: false, reason: decision.capped.length ? 'capped' : 'none', pending: decision.continuation !== undefined && decision.continuation !== null, waitingReplyTo };
  if (decision.continuation) {
    const c = decision.continuation;
    const door = deps.startTurnIfIdle(c.text, { origin: 'goal-continue', reason: `requirement ${c.requirementId} open` });
    if (door.opened) {
      noteContinuationOpened(store, c, now);
      // R ① — one continuation system: a requirement continuation carries the same side-effect budget as a goal drive.
      try { (require('../llm/seat-action-stationarity.js') as typeof import('../llm/seat-action-stationarity.js')).armDriveContinuation(); } catch { /* fail-open */ }
      log(CATEGORY, 'continue', { requirementId: c.requirementId, requirementIds: c.items.map((item) => item.requirementId), fingerprint: c.fingerprint, turnId: door.turnId });
      result = { opened: true, reason: 'requirement-open', pending: true, waitingReplyTo };
    } else {
      // Not counted: the next turn end tries again with the same fingerprint still fresh.
      log(CATEGORY, 'continue-rejected', { requirementId: c.requirementId, reason: door.reason });
      result = { opened: false, reason: door.reason, pending: true, waitingReplyTo };
    }
  }
  if (decision.capped.length) log(CATEGORY, 'capped', { requirementIds: decision.capped });
  writeStore(path, store);
  return result;
}

/**
 * REQ-BLOCK-ROUTE-TO-ASKEE — every BLOCKED requirement goes to whoever is blocking it (re-ask → exception line), or closes
 * as stale. A CEO card only for a CEO line with a CEO-only gap. Fail-soft: a mail/card error is logged and retried next turn end.
 */
export function routeBlockedRequirements(
  store: { requirements: Requirement[] }, fresh: ReadonlyArray<{ requirementId: string; line: string }>, deps: RequirementTurnEndDeps, now: Date,
  log: (category: string, event: string, data: Record<string, unknown>) => void,
): void {
  const seat = deps.seat!;
  const at = now.toISOString();
  const lineOf = new Map(fresh.map((b) => [b.requirementId, b.line]));
  const coordinatorOf = deps.coordinatorOf ?? defaultCoordinatorOf;
  const post = deps.postMail ?? defaultPostMail(seat);
  for (const r of store.requirements) {
    if (r.status !== 'blocked') continue;
    const route = routeBlocked(r, { seat, now, coordinatorOf });
    try {
      if (route.kind === 'ceo-card') {
        if (r.exceptionCard) continue;
        const card = (deps.raiseException ?? ((req, line, gap) => defaultRaiseException(seat, req, line, gap)))(r, lineOf.get(r.id) ?? r.title, route.gap);
        if (card) r.exceptionCard = card;
        log(CATEGORY, 'blocked-route', { requirementId: r.id, route: 'ceo-card', gap: route.gap, ...(card ? { card } : {}) });
      } else if (route.kind === 'reask') {
        const msgId = post({ to: route.to, kind: 'question', body: route.body, refs: [`req-reask:${r.id}`] });
        r.blockRoute = { ...r.blockRoute, reaskAt: at, reaskTo: route.to, ...(msgId ? { reaskMsgId: msgId } : {}) };
        log(CATEGORY, 'blocked-route', { requirementId: r.id, route: 'reask', to: route.to, ...(msgId ? { msgId } : {}) });
      } else if (route.kind === 'exception') {
        const msgId = post({ to: route.to, kind: 'exception', body: route.body, refs: [`req-exception:${r.id}`] });
        r.blockRoute = { ...r.blockRoute, exceptionAt: at, exceptionTo: route.to };
        log(CATEGORY, 'blocked-route', { requirementId: r.id, route: 'exception', to: route.to, ...(msgId ? { msgId } : {}) });
      } else if (route.kind === 'stale') {
        markStale(r, route.note, at);
        log(CATEGORY, 'stale', { requirementId: r.id, note: route.note });
      }
    } catch (error) {
      log(CATEGORY, 'blocked-route-failed', { requirementId: r.id, route: route.kind, error: String(error).slice(0, 200) });
    }
  }
}
