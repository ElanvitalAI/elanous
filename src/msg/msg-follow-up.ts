// Request/decision follow-up: reuse the commitment-bound, bounded self timer.
// COND-WATCH(11-25): a sender that states the awaited outcome (`watch`) gets a ledger watch instead of a reply-wait —
// the commitment closes itself with the evidence line when the outcome appears (no «please reply» loop).
import { spawnElanous } from '../instance/spawn-elanous.js';
import { getElanousConfigDirOverride } from '../elanous-config-dir.js';
import { CommitmentLedger } from '../commitment/ledger.js';
import { armWaker, formatWaitCondition, parseWaitCondition, type SelfTimerDeps } from './self-timer-watch.js';
import type { Message } from './msg-store.js';

// OP #136641: check a delegated request again after at most 30 minutes.
export const FOLLOW_UP_MS = 30 * 60_000;
// COND-WATCH: an outcome watch (pregate ≈ 20–60 min · a land train longer) waits up to 2h before its one expiry wake.
export const WATCH_FOLLOW_UP_MS = 2 * 60 * 60_000;
// Same startup grace as the event transport's 10-second response bound.
const WATCHER_START_GRACE_MS = 10_000;
const launching = new Set<string>();

export interface FollowUpDeps {
  readonly ledger?: CommitmentLedger;
  readonly timer?: SelfTimerDeps;
  readonly launch?: (input: { seat: string; commitmentId: string; condition: string; within: string }) => Promise<void>;
}

/** Start the existing bounded watcher in its own process so a REPL turn ending cannot cancel it. */
async function launchWatcher(input: { seat: string; commitmentId: string; condition: string; within: string }): Promise<void> {
  const configDir = getElanousConfigDirOverride();
  const child = spawnElanous([...(configDir ? ['--config-dir', configDir] : []), 'msg', 'wait-for', input.condition, '--notify', input.seat,
    '--commitment', input.commitmentId, '--within', input.within], { detached: true, stdio: 'ignore' });
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
}

export interface FollowUpResult { commitmentId: string; wakerId: string; condition: string; merged: boolean; watch?: boolean }

export async function armMessageFollowUp(message: Message, pr: number | undefined, deps: FollowUpDeps = {}, watch?: string): Promise<FollowUpResult> {
  const ledger = deps.ledger ?? new CommitmentLedger();
  const condition = watch !== undefined ? formatWaitCondition(parseWaitCondition(watch))
    : pr === undefined ? `mail-reply:${message.id}` : `pr-merged:${pr}`;
  const isWatch = watch !== undefined;
  const withinMs = isWatch ? WATCH_FOLLOW_UP_MS : FOLLOW_UP_MS;
  // OP-CLOSE-ON-OUTCOME — a watched delegation records its done-when predicate, its check-at time and the assignee.
  const checkAt = new Date(Date.now() + withinMs).toISOString();
  const commitment = ledger.add({ seat: message.from, sessionId: `msg:${message.id}`,
    text: isWatch ? `Watch ${condition} (message #${message.id} to ${message.to})` : `Follow up on message #${message.id} to ${message.to}`,
    evidence: `MsgPost #${message.id}`, source: 'explicit',
    ...(isWatch || pr !== undefined ? { doneWhen: condition } : {}), checkAt, assignee: message.to }).entry;
  const armed = armWaker({ seat: message.from, commitmentId: commitment.id, condition, withinMs, ...(isWatch ? { autoClose: true } : {}) }, { ...deps.timer, ledger });
  let alive = false;
  if (armed.waker.watcherPid !== undefined) { try { process.kill(armed.waker.watcherPid, 0); alive = true; } catch { /* stale watcher can be restarted */ } }
  const key = `${message.from}/${armed.waker.id}`;
  if ((!armed.merged || !alive) && !launching.has(key)) {
    launching.add(key);
    try {
      await (deps.launch ?? launchWatcher)({ seat: message.from, commitmentId: commitment.id, condition, within: `${withinMs / 60_000}m` });
      const timer = setTimeout(() => launching.delete(key), WATCHER_START_GRACE_MS); timer.unref?.();
    } catch (error) { launching.delete(key); throw error; }
  }
  return { commitmentId: commitment.id, wakerId: armed.waker.id, condition, merged: armed.merged, watch: isWatch };
}
