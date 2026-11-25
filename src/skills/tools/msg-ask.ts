import type { LLMToolSpec } from '../../llm/tool-spec.js';

import { openMsgStore, validateMessageEnvelope, type Message, type MsgStore } from '../../msg/msg-store.js';
import { laterMailFrom, MSG_WAIT_DEFAULT_WITHIN_MS, MSG_WAIT_EVENTS, MSG_WAIT_LOG_CATEGORY, MSG_WAIT_RETRY_GRACE_MS, waitUntilRef } from '../../msg/msg-wait-contract.js';
import { debug } from '../../debug/log.js';

export interface MsgAskDeps {
  openStore?: () => MsgStore;
  sleep?: (ms: number) => Promise<void>;
  monotonicNow?: () => number;
  wallNow?: () => number;
  signal?: AbortSignal;
}

export interface MsgAskResult extends Record<string, unknown> {
  output: string;
  ok: boolean;
  question: Message;
  reply: Message | null;
}

export function buildMsgAskTool(): LLMToolSpec {
  return {
    name: 'MsgAsk',
    description: 'Post a durable seat question, then wait for the reply: a message whose replyTo points to it, or any later message from the recipient to you. '
      + 'A timeout or cancellation keeps the posted question and returns its ID. The reply contract continues on the ledger: '
      + 'no reply in 10 minutes → one reminder to the recipient; 5 more minutes → the wait is cancelled and you get a notice (proceed with the part independent of the reply).',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Asking seat (ALL cannot send).' },
        to: { type: 'string', description: 'Recipient seat.' },
        question: { type: 'string', description: 'Nonempty question body.' },
        waitSeconds: { type: 'integer', description: 'Wait 0–300 seconds (clamped); default 60.' },
      },
      required: ['from', 'to', 'question'],
      additionalProperties: false,
    },
  };
}

export async function dispatchMsgAsk(rawArgs: Record<string, unknown>, deps: MsgAskDeps = {}): Promise<MsgAskResult> {
  // MSG-FILTERS-RELAX: an out-of-range or non-integer wait is clamped to 0–300 s, never a refused question.
  const waitNumber = Number(rawArgs.waitSeconds ?? 60);
  const waitRaw = Number.isFinite(waitNumber) ? Math.min(300, Math.max(0, Math.round(waitNumber))) : 60;
  const wallNowForContract = deps.wallNow ?? Date.now;
  // MSG-WAIT-CONTRACT ② — the question carries its reply horizon (default 10m) on the ledger; the TUI tick / msg wait-tick
  // sends the one reminder at the horizon and cancels 5 min later, after this blocking call has returned.
  const envelope = validateMessageEnvelope({
    from: rawArgs.from,
    to: rawArgs.to,
    body: rawArgs.question,
    kind: 'question',
    refs: [waitUntilRef(wallNowForContract() + MSG_WAIT_DEFAULT_WITHIN_MS)],
  });
  if (envelope.to === 'ALL') throw new Error("'to' must name one recipient seat for MsgAsk");
  const monotonicNow = deps.monotonicNow ?? (() => performance.now());
  const wallNow = deps.wallNow ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const store = deps.openStore?.() ?? openMsgStore();
  try {
    if (deps.signal?.aborted) throw new Error('ask cancelled before posting');
    const question = store.post(envelope);
    const startedAt = monotonicNow();
    const wallStartedAt = wallNow();
    const deadline = startedAt + waitRaw * 1000;
    const wallDeadline = Date.parse(question.createdAt) + waitRaw * 1000;
    // Ledger timestamps are wall time while the wait budget is monotonic.
    // If the two clocks diverge materially, preserve the question ID and
    // make the uncertain result explicit instead of accepting a late reply.
    const clockAdjusted = () => Math.abs((wallNow() - wallStartedAt) - (monotonicNow() - startedAt)) > 250;
    let afterId = 0;
    // HAND-RAISE-LADDER — a ✋ to the asking seat ends the wait early (checked at most once a second).
    const ladder = require('../../msg/hand-raise-ladder.js') as typeof import('../../msg/hand-raise-ladder.js');
    let handCheckedAt = Number.NEGATIVE_INFINITY;
    do {
      if (monotonicNow() - handCheckedAt >= 1000) {
        handCheckedAt = monotonicNow();
        const hand = ladder.handArrivedAfter(store, question.from, question.id);
        if (hand) return { output: `MsgAsk #${question.id} posted; ${ladder.handPreemptLine(hand)}`, ok: false, question, reply: null };
      }
      if (deps.signal?.aborted) {
        return { output: `MsgAsk #${question.id} posted; wait cancelled`, ok: false, question, reply: null };
      }
      if (clockAdjusted()) {
        return { output: `MsgAsk #${question.id} posted; clock adjusted during wait, inspect linked replies`, ok: false, question, reply: null };
      }
      const replies = store.listReplies(question.id, 1000, afterId);
      if (clockAdjusted()) {
        return { output: `MsgAsk #${question.id} posted; clock adjusted during wait, inspect linked replies`, ok: false, question, reply: null };
      }
      for (const reply of replies) {
        afterId = reply.id;
        // A replyTo link alone does not prove the intended seat answered.
        // A wall-clock timestamp can move backwards by less than the clock
        // adjustment guard. Never accept a reply once monotonic time expired.
        // This conservatively leaves replies observed late for follow-up.
        if (reply.from === question.to && reply.to === question.from
          && monotonicNow() <= deadline && Date.parse(reply.createdAt) <= wallDeadline) {
          return { output: `MsgAsk #${question.id} → reply #${reply.id}: ${reply.body}`, ok: true, question, reply };
        }
      }
      // MSG-WAIT-CONTRACT ① — no linked reply: ANY later mail from the recipient to the asker counts (logged).
      const bySender = laterMailFrom(store, { after: question.id, from: question.to, to: question.from });
      if (bySender && monotonicNow() <= deadline && Date.parse(bySender.createdAt) <= wallDeadline) {
        try { debug.log(MSG_WAIT_LOG_CATEGORY, MSG_WAIT_EVENTS.matchedBySender, { question: question.id, asker: question.from, counterpart: question.to, reply: bySender.id }); } catch { /* fail-open */ }
        return { output: `MsgAsk #${question.id} → reply #${bySender.id}: ${bySender.body}`, ok: true, question, reply: bySender };
      }
      const remaining = deadline - monotonicNow();
      if (deps.signal?.aborted) {
        return { output: `MsgAsk #${question.id} posted; wait cancelled`, ok: false, question, reply: null };
      }
      if (remaining <= 0) {
        return { output: `MsgAsk #${question.id} posted; no linked reply within ${waitRaw}s — the reply wait continues on the ledger: `
          + `one reminder at ${MSG_WAIT_DEFAULT_WITHIN_MS / 60_000}m, cancelled at ${(MSG_WAIT_DEFAULT_WITHIN_MS + MSG_WAIT_RETRY_GRACE_MS) / 60_000}m (you get a notice)`, ok: false, question, reply: null };
      }
      // A full page may repeat forever. Yield so timers and AbortSignal
      // callbacks can run before asking SQLite for the next page.
      await sleep(replies.length === 1000 ? 0 : Math.min(100, remaining));
    } while (true);
  } finally {
    store.close();
  }
}
