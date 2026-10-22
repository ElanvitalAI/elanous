import type { LLMToolSpec } from '../../llm.js';
import { openMsgStore, validateMessageEnvelope, type Message, type MsgStore } from '../../msg/msg-store.js';

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
    description: 'Post a durable seat question, then wait for the first message whose replyTo points to it. A timeout or cancellation keeps the posted question and returns its ID for later follow-up.',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Asking seat (ALL cannot send).' },
        to: { type: 'string', description: 'Recipient seat.' },
        question: { type: 'string', description: 'Nonempty question body.' },
        waitSeconds: { type: 'integer', description: 'Wait 0–300 seconds; default 60.' },
      },
      required: ['from', 'to', 'question'],
      additionalProperties: false,
    },
  };
}

export async function dispatchMsgAsk(rawArgs: Record<string, unknown>, deps: MsgAskDeps = {}): Promise<MsgAskResult> {
  const waitRaw = rawArgs.waitSeconds ?? 60;
  if (typeof waitRaw !== 'number' || !Number.isSafeInteger(waitRaw) || waitRaw < 0 || waitRaw > 300) {
    throw new Error("'waitSeconds' must be an integer between 0 and 300");
  }
  const envelope = validateMessageEnvelope({
    from: rawArgs.from,
    to: rawArgs.to,
    body: rawArgs.question,
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
    do {
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
      const remaining = deadline - monotonicNow();
      if (deps.signal?.aborted) {
        return { output: `MsgAsk #${question.id} posted; wait cancelled`, ok: false, question, reply: null };
      }
      if (remaining <= 0) {
        return { output: `MsgAsk #${question.id} posted; no linked reply within ${waitRaw}s`, ok: false, question, reply: null };
      }
      // A full page may repeat forever. Yield so timers and AbortSignal
      // callbacks can run before asking SQLite for the next page.
      await sleep(replies.length === 1000 ? 0 : Math.min(100, remaining));
    } while (true);
  } finally {
    store.close();
  }
}
