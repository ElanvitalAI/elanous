import type { MsgLedgerDeps } from '../skills/tools/ops-ledger.js';
import type { MsgAskDeps } from '../skills/tools/msg-ask.js';

const MESSAGE_TOOL_NAMES = new Set(['MsgList', 'MsgPost', 'MsgAsk', 'MsgAck']);

/** The next TUI REPL can dispatch only its durable message tools directly.
 * Other native runtimes keep the REPL's existing unavailable boundary. */
export function isReplMessageTool(name: string): boolean {
  return MESSAGE_TOOL_NAMES.has(name);
}

export async function dispatchReplMessageTool(
  name: string,
  args: Record<string, unknown>,
  deps: { ledger?: MsgLedgerDeps; ask?: MsgAskDeps; signal?: AbortSignal } = {},
): Promise<Record<string, unknown>> {
  if (!isReplMessageTool(name)) throw new Error(`not a REPL message tool: ${name}`);
  const { observeLedgerCall } = await import('../skills/tools/ops-ledger.js');
  if (name === 'MsgAsk') {
    const { dispatchMsgAsk } = await import('../skills/tools/msg-ask.js');
    return observeLedgerCall(name, args,
      () => dispatchMsgAsk(args, { ...deps.ask, signal: deps.signal ?? deps.ask?.signal }),
      (a, r) => ({ from: a.from, to: a.to, ...(r ? { id: r.question.id, replied: r.reply !== null } : {}) }));
  }
  const { dispatchMsgList, dispatchMsgPost, dispatchMsgAck } = await import('../skills/tools/ops-ledger.js');
  if (name === 'MsgList') return observeLedgerCall(name, args, () => dispatchMsgList(args, deps.ledger),
    (a, r) => ({ to: a.to, ...(r ? { count: r.count, after: r.after } : {}) }));
  if (name === 'MsgPost') return observeLedgerCall(name, args, () => dispatchMsgPost(args, deps.ledger),
    (a, r) => ({ from: a.from, to: a.to, ...(r ? { id: r.message.id } : {}) }));
  return observeLedgerCall(name, args, () => dispatchMsgAck(args, deps.ledger),
    (a, r) => ({ to: a.to, id: a.id, ...(r ? { cursor: r.cursor } : {}) }));
}
