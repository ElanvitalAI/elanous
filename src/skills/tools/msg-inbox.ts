import { canonicalSeatId, openMsgStoreReadOnly, type Message, type MsgStore } from '../../msg/msg-store.js';

/** Core mailbox read for an MCP adapter with a trusted caller seat. */
export interface MsgInboxDeps {
  /** Bound by the host from authenticated context, never from tool arguments. */
  seat: string;
  openStore?: () => MsgStore;
}

export interface MsgInboxResult extends Record<string, unknown> {
  output: string;
  ok: true;
  recipient: string;
  after: number;
  count: number;
  messages: Message[];
}

export async function dispatchMsgInbox(args: Record<string, unknown>, deps: MsgInboxDeps): Promise<MsgInboxResult> {
  if (Object.keys(args).some((key) => key !== 'after' && key !== 'limit')) {
    throw new Error('MsgInbox accepts only after and limit; recipient is bound by the host');
  }
  const recipient = canonicalSeatId(deps.seat);
  if (recipient === 'ALL') throw new Error('ALL is a topic, not an authenticated seat');
  const after = args.after;
  if (after !== undefined && (!Number.isSafeInteger(after) || typeof after !== 'number' || after < 0)) {
    throw new Error('after must be a nonnegative integer');
  }
  const limit = args.limit === undefined ? 100 : args.limit;
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('limit must be an integer between 1 and 100');
  }
  const store = deps.openStore?.() ?? openMsgStoreReadOnly();
  try {
    const cursor = store.getCursor(recipient);
    const start = typeof after === 'number' ? Math.max(cursor, after) : cursor;
    const messages = store.list(recipient, start, limit);
    return { output: `MsgInbox ${recipient}: ${messages.length} message(s) after #${start}`,
      ok: true, recipient, after: start, count: messages.length, messages };
  } finally {
    store.close();
  }
}
