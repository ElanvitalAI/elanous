// ── Ops-ledger tool runtimes (우편 msg · 판 release checklist) ──
//
// Registers the in-process ledger tools with the tool-runtime
// layer so every surface (skill-runner, TUI) can call them by name:
// MsgList / MsgPost / MsgAsk / MsgAck / MsgInbox and ChecklistList / ChecklistAdd /
// ChecklistSet / ChecklistEdit / ChecklistMove. Dispatchers live in
// src/skills/tools/ops-ledger.ts; this file is a thin adapter — the
// same pattern as team-tool-runtimes.ts. Every call goes through
// `observeLedgerCall` — one `ops-ledger` `call` line with the tool, the
// elapsed ms, ok, the seat actor and ids (never bodies or evidence).

import {
  buildMsgListTool, dispatchMsgList,
  buildMsgPostTool, dispatchMsgPost,
  buildMsgAckTool, dispatchMsgAck,
  buildChecklistListTool, dispatchChecklistList,
  buildChecklistAddTool, dispatchChecklistAdd,
  buildChecklistSetTool, dispatchChecklistSet,
  buildChecklistMoveTool, dispatchChecklistMove,
  buildChecklistEditTool, dispatchChecklistEdit,
  type ChecklistAddResult, type ChecklistEditResult, type ChecklistListResult, type ChecklistMoveResult,
  type ChecklistSetResult, type MsgAckResult, type MsgListResult, type MsgPostResult,
  observeLedgerCall,
} from '../skills/tools/ops-ledger.js';
import type { ToolRuntime } from './types.js';
import { buildMsgAskTool, dispatchMsgAsk, type MsgAskResult } from '../skills/tools/msg-ask.js';
import { dispatchMsgInbox, type MsgInboxResult } from '../skills/tools/msg-inbox.js';
import { canonicalSeatId } from '../msg/msg-store.js';
import { buildCommitmentCloseTool, dispatchCommitmentClose, type CommitmentCloseToolResult } from '../commitment/close.js';
import { buildHandRaiseTool, dispatchHandRaise, type HandRaiseToolResult } from '../skills/tools/hand-raise-tool.js';
import { buildSeatAssignTool, dispatchSeatAssign, type SeatAssignToolResult } from '../skills/tools/seat-assign-tool.js';

export const msgListRuntime: ToolRuntime<Record<string, unknown>, MsgListResult> = {
  id: 'msg_list',
  spec: buildMsgListTool(),
  async run(req) { return observeLedgerCall('MsgList', req, () => dispatchMsgList(req), (a, r) => ({ to: a.to, ...(r ? { count: r.count, total: r.total, hasMore: r.hasMore, after: r.after } : {}) })); },
};

export const msgPostRuntime: ToolRuntime<Record<string, unknown>, MsgPostResult> = {
  id: 'msg_post',
  spec: buildMsgPostTool(),
  async run(req) { return observeLedgerCall('MsgPost', req, () => dispatchMsgPost(req), (a, r) => ({ from: a.from, to: a.to, ...(r ? (r.message ? { id: r.message.id } : { diverted: r.diverted }) : {}) })); },
};

export const msgAskRuntime: ToolRuntime<Record<string, unknown>, MsgAskResult> = {
  id: 'msg_ask',
  spec: buildMsgAskTool(),
  async run(req, ctx) { return observeLedgerCall('MsgAsk', req, () => dispatchMsgAsk(req, { signal: ctx.signal }), (a, r) => ({ from: a.from, to: a.to, ...(r ? { id: r.question.id, replied: r.reply !== null } : {}) })); },
};

export const msgAckRuntime: ToolRuntime<Record<string, unknown>, MsgAckResult> = {
  id: 'msg_ack',
  spec: buildMsgAckTool(),
  async run(req, ctx) {
    if (ctx.surface === 'mcp') {
      const seat = ctx.authenticatedSeat;
      if (!seat) throw new Error('MsgAck requires a host-authenticated seat');
      if (Object.keys(req).some(key => key !== 'id' && key !== 'ids' && key !== 'receipted' && key !== 'apply')) throw new Error('MCP MsgAck accepts id, ids, receipted and apply; recipient is bound by the host');
      const to = canonicalSeatId(seat);
      if (to === 'ALL') throw new Error('ALL is a topic, not an authenticated seat');
      const bound = { to, ...(req.id === undefined ? {} : { id: req.id }), ...(req.ids === undefined ? {} : { ids: req.ids }), ...(req.receipted === undefined ? {} : { receipted: req.receipted }), ...(req.apply === undefined ? {} : { apply: req.apply }) };
      return observeLedgerCall('MsgAck', bound, () => dispatchMsgAck(bound), (a, r) => ({ to: a.to, id: a.id, ...(r ? { cursor: r.cursor, acked: r.acked.length } : {}) }));
    }
    return observeLedgerCall('MsgAck', req, () => dispatchMsgAck(req), (a, r) => ({ to: a.to, id: a.id, ...(r ? { cursor: r.cursor, acked: r.acked.length } : {}) }));
  },
};

export const msgInboxRuntime: ToolRuntime<Record<string, unknown>, MsgInboxResult> = {
  id: 'msg_inbox',
  spec: {
    name: 'MsgInbox',
    description: 'Read unread durable messages for the host-authenticated seat. Reading never advances the acknowledgement cursor.',
    parameters: {
      type: 'object', properties: {
        after: { type: 'integer', description: 'Optional exclusive message ID; omitted starts at the authenticated seat acknowledgement cursor.' },
        limit: { type: 'integer', description: 'Maximum messages to return, 1–100 (default 100).' },
      }, additionalProperties: false,
    },
  },
  async run(req, ctx) {
    if (!ctx.authenticatedSeat) throw new Error('MsgInbox requires a host-authenticated seat');
    return dispatchMsgInbox(req, { seat: ctx.authenticatedSeat });
  },
};

export const checklistListRuntime: ToolRuntime<Record<string, unknown>, ChecklistListResult> = {
  id: 'checklist_list',
  spec: buildChecklistListTool(),
  async run(req) { return observeLedgerCall('ChecklistList', req, () => dispatchChecklistList(req), (a, r) => ({ version: r?.version ?? a.version, ...(r ? { items: r.items.length, history: r.history.length } : {}) })); },
};

export const checklistAddRuntime: ToolRuntime<Record<string, unknown>, ChecklistAddResult> = {
  id: 'checklist_add',
  spec: buildChecklistAddTool(),
  async run(req) { return observeLedgerCall('ChecklistAdd', req, () => dispatchChecklistAdd(req), (a, r) => ({ id: a.id, version: r?.version ?? a.version })); },
};

export const checklistSetRuntime: ToolRuntime<Record<string, unknown>, ChecklistSetResult> = {
  id: 'checklist_set',
  spec: buildChecklistSetTool(),
  async run(req) { return observeLedgerCall('ChecklistSet', req, () => dispatchChecklistSet(req), (a, r) => ({ id: a.id, version: r?.version ?? a.version, ...(a.status === undefined ? {} : { status: a.status }) })); },
};

export const checklistEditRuntime: ToolRuntime<Record<string, unknown>, ChecklistEditResult> = {
  id: 'checklist_edit',
  spec: buildChecklistEditTool(),
  async run(req) { return observeLedgerCall('ChecklistEdit', req, () => dispatchChecklistEdit(req), (a, r) => ({ id: a.id, version: r?.version ?? a.version, field: a.field })); },
};

export const checklistMoveRuntime: ToolRuntime<Record<string, unknown>, ChecklistMoveResult> = {
  id: 'checklist_move',
  spec: buildChecklistMoveTool(),
  async run(req) { return observeLedgerCall('ChecklistMove', req, () => dispatchChecklistMove(req), (a) => ({ id: a.id, from: a.from, to: a.to })); },
};

// COMMITMENT-CLOSE — close a commitment (done|blocked ⊕ evidence) and cancel its waker.
export const commitmentCloseRuntime: ToolRuntime<Record<string, unknown>, CommitmentCloseToolResult> = {
  id: 'commitment_close',
  spec: buildCommitmentCloseTool(),
  async run(req) { return dispatchCommitmentClose(req); },
};

// HAND-RAISE-LADDER — give a ✋ NEED HUMAN mail its one outcome (resolve · reject · escalate up the federation ladder).
export const handRaiseRuntime: ToolRuntime<Record<string, unknown>, HandRaiseToolResult> = {
  id: 'hand_raise',
  spec: buildHandRaiseTool(),
  async run(req, ctx) {
    const actor = ctx.surface === 'mcp' ? ctx.authenticatedSeat ?? undefined : undefined;
    return observeLedgerCall('HandRaise', req, async () => dispatchHandRaise(req, actor ? { actor } : {}),
      (a, r) => ({ action: a.action, msgId: a.msgId, ...(r ? { to: r.to, mailId: r.mailId } : {}) }));
  },
};

// OP-HANDLES-L2b — assign a checklist cell to a hand seat in one call (owner ⊕ mail ⊕ idle wake · built-in writer check).
export const seatAssignRuntime: ToolRuntime<Record<string, unknown>, SeatAssignToolResult> = {
  id: 'seat_assign',
  spec: buildSeatAssignTool(),
  async run(req, ctx) {
    const actor = ctx.surface === 'mcp' ? ctx.authenticatedSeat ?? undefined : undefined;
    return observeLedgerCall('SeatAssign', req, () => dispatchSeatAssign(req, actor ? { actor } : {}),
      (a, r) => ({ seat: a.seat, cellId: a.cellId, ...(r ? { ok: r.result.ok, ...(r.result.ok ? { mailId: r.result.mailId } : { code: r.result.code }) } : {}) }));
  },
};

export const ALL_OPS_LEDGER_RUNTIMES: ToolRuntime<any, any>[] = [
  msgListRuntime,
  msgPostRuntime,
  msgAskRuntime,
  msgAckRuntime,
  msgInboxRuntime,
  checklistListRuntime,
  checklistAddRuntime,
  checklistSetRuntime,
  checklistEditRuntime,
  checklistMoveRuntime,
  commitmentCloseRuntime,
  handRaiseRuntime,
  seatAssignRuntime,
];
