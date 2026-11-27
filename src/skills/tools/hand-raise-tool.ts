// HAND-RAISE-LADDER — the seat tool `HandRaise(action, msgId, text)`: the one door that gives a ✋ NEED HUMAN mail its
// outcome (resolve · reject · escalate). CLI twin: `eln msg hand <msgId> resolve|reject|escalate "<text>"`.
import type { LLMToolSpec } from '../../llm/tool-spec.js';
import type { HandAction, HandOutcomeResult } from '../../msg/hand-raise-ladder.js';
import type { MsgStore } from '../../msg/msg-store.js';

export const HAND_RAISE_TOOL_NAME = 'HandRaise';

export function buildHandRaiseTool(): LLMToolSpec {
  return {
    name: HAND_RAISE_TOOL_NAME,
    description: 'Give a ✋ NEED HUMAN mail its one outcome. resolve = reply to the blocked seat with your decision; reject = reply with the reason; '
      + 'escalate = forward it to your parent on the federation ladder (hand → space coordinator → OP → CEO decision card) with one line of context. '
      + 'A ✋ with no outcome is escalated for you after 10 minutes. CLI twin: eln msg hand <msgId> resolve|reject|escalate "<text>". '
      + 'resolve REQUIRES owner + deadline + a concrete next step; a HOLD / 유지 / 보류 / wait answer is refused. Standard answers: '
      + '(1) continue on top of PR #n · (2) coordinate one mail then proceed in 30 min · (3) new branch, keep uncommitted files · (4) policy auto — RES/REL absorbed.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['resolve', 'reject', 'escalate'], description: 'resolve · reject · escalate' },
        msgId: { type: 'integer', description: 'The ✋ mail ID.' },
        text: { type: 'string', description: 'resolve: the decision · reject: the reason · escalate: one line of context for the parent.' },
        owner: { type: 'string', description: 'resolve: the seat that does the next step (required for resolve).' },
        deadline: { type: 'string', description: 'resolve: by when, ISO time or e.g. 30m (required for resolve).' },
        seat: { type: 'string', description: 'Optional acting seat; defaults to the ✋ receiver.' },
      },
      required: ['action', 'msgId', 'text'],
      additionalProperties: false,
    },
  };
}

export interface HandRaiseToolResult extends Record<string, unknown>, HandOutcomeResult { readonly ok: true }

export function dispatchHandRaise(args: Record<string, unknown>, deps: { openStore?: () => MsgStore; ladder?: import('../../msg/hand-raise-ladder.js').FederationLadder; actor?: string; now?: () => number } = {}): HandRaiseToolResult {
  const ladderModule = require('../../msg/hand-raise-ladder.js') as typeof import('../../msg/hand-raise-ladder.js');
  const { openMsgStore } = require('../../msg/msg-store.js') as typeof import('../../msg/msg-store.js');
  const msgId = Number(args.msgId);
  if (!Number.isSafeInteger(msgId) || msgId < 1) throw new Error('msgId must be a positive integer');
  const action = String(args.action ?? '').trim().toLowerCase() as HandAction;
  const actor = deps.actor ?? (typeof args.seat === 'string' && args.seat.trim() ? args.seat : undefined);
  const owner = typeof args.owner === 'string' ? args.owner.trim() : '';
  const deadline = normalizeDeadline(typeof args.deadline === 'string' ? args.deadline : '', deps.now?.() ?? Date.now());
  const store = deps.openStore?.() ?? openMsgStore();
  try {
    // LEADER-HAND-CONTRACT ① — the tool door: resolve names owner ⊕ deadline, always.
    if (action === 'resolve' && (!owner || !deadline)) {
      ladderModule.recordHoldReject(store, { msgId, actor: actor ?? 'unknown', via: 'tool', now: deps.now?.() ?? Date.now() });
      throw new Error(`resolve needs owner and deadline. ${ladderModule.holdRejectMessage(msgId)}`);
    }
    // 11-26 21:42 OP: a ✋ re-delivered after an over-budget turn was resolved a second time → «dispatch failed: already
    // resolved». The guard is right; the answer is a no-op, not an error — it names the outcome so the seat moves on.
    const already = (() => { const hand = ladderModule.readHandMail(store, msgId); const closed = hand ? ladderModule.handClosedOn(store, hand) : null;
      return closed === 'resolved' || closed === 'rejected' ? closed : null; })();
    if (already && action !== 'escalate') {
      return { ok: true, action, msgId, to: '', mailId: null, noop: true,
        output: `✋ #${msgId} is already ${already} — nothing sent (no-op). Move on to the next item.` };
    }
    const result = ladderModule.applyHandOutcome(store, { msgId, action, text: typeof args.text === 'string' ? args.text : '', via: 'tool',
      ...(actor ? { actor } : {}), ...(action === 'resolve' ? { owner, deadline } : {}) }, {
      ladder: deps.ladder ?? ladderModule.loadFederationLadder(), now: deps.now ?? (() => Date.now()), raiseDecision: ladderModule.spawnHandDecision,
      log: (event, data) => { try { (require('../../debug/log.js') as typeof import('../../debug/log.js')).debug.log('needhuman', event, data); } catch { /* fail-open */ } },
    });
    return { ok: true, ...result };
  } finally { store.close(); }
}

/** «30m» / «2h» → ISO from now; an ISO-ish value passes through; empty → ''. */
export function normalizeDeadline(value: string, now: number): string {
  const v = value.trim();
  const rel = /^(\d+)\s*(m|min|h)$/i.exec(v);
  if (rel) return new Date(now + Number(rel[1]) * (rel[2]!.toLowerCase() === 'h' ? 3_600_000 : 60_000)).toISOString();
  return v;
}
