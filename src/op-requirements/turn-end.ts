// OP-REQUIREMENT-LOOP — the turn-end adapter: gather structured inputs, decide, open ONE continuation through the
// existing internal-turn door, persist. entry.ts stays a hook; every read is fail-soft (a gather error never blocks
// a turn end, it only seeds less).
import type { StartTurnIfIdleOptions, StartTurnIfIdleResult } from '../chat/internal-turn-contract.js';
import { debug } from '../debug/log.js';
import {
  decideTurnEnd, noteContinuationOpened, readStore, requirementStorePath, seedRequirements, writeStore,
  type Requirement, type SeedInput, type WaitFor, type WaitState,
} from './requirement-loop.js';

export const REQUIREMENT_LOOP_SEAT = 'OP';
const CATEGORY = 'op.requirements';

export interface RequirementTurnEndDeps {
  seat: string | null;
  /** This turn's text when its structured source is a person (`from.kind === 'human'`), else null. */
  humanTurn: { turnId: string; text: string } | null;
  startTurnIfIdle: (text: string, opts: StartTurnIfIdleOptions) => StartTurnIfIdleResult;
  notify?: (line: string) => void;
  now?: () => Date;
  stateRoot?: () => string;
  /** Test seam: replaces the checklist/commitment/waker reads. */
  gather?: () => Promise<{ seed: SeedInput; waitState: (r: Requirement) => WaitState }>;
  log?: (category: string, event: string, data: Record<string, unknown>) => void;
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
    const { devVersion, listChecklist, ownerMatches } = await import('../release-loop/checklist.js');
    const { releaseLedgerRoot } = await import('../instance/resolve.js');
    const version = devVersion().replace(/-dev\.\d+$/, '');
    seed.p0Cells = listChecklist(version, releaseLedgerRoot()).items
      .filter((item) => item.priority === 'P0' && ownerMatches(item.owner, seat))
      .map((item) => ({ version, id: item.id, title: item.title, status: item.status }));
  } catch (error) { debug.log(CATEGORY, 'gather-failed', { source: 'checklist', error: String(error).slice(0, 200) }); }
  const wakerStatus = new Map<string, { status: WaitState; wait: WaitFor }>();
  try {
    const { CommitmentLedger } = await import('../dashboard/input/commitment-ledger.js');
    const { listWakers } = await import('../msg/self-timer-watch.js');
    for (const w of listWakers(seat)) {
      // Later records win: a re-armed waker replaces a fired or expired one.
      wakerStatus.set(w.commitmentId, { status: w.status, wait: { commitmentId: w.commitmentId, condition: w.condition, deadlineAt: w.deadlineAt } });
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
  const gathered = await (deps.gather ?? (() => defaultGather(deps.seat!)))();
  seedRequirements(store, { ...gathered.seed, ...(deps.humanTurn ? { directives: [deps.humanTurn] } : {}) }, now.toISOString());
  const decision = decideTurnEnd(store, { now, waitState: gathered.waitState });
  if (decision.escalated.length) log(CATEGORY, 'escalated', { requirementIds: decision.escalated, count: decision.escalated.length });
  for (const e of decision.expired) log(CATEGORY, 'expired', { requirementId: e.requirementId, line: e.line });
  for (const b of decision.blocked) {
    log(CATEGORY, 'blocked', { requirementId: b.requirementId, code: 'SAME_GAP' });
    deps.notify?.(b.line);
  }
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
