// ── Ops-ledger tool runtimes (우편 msg · 판 release checklist) ──
//
// Registers the eight in-process ledger tools with the tool-runtime
// layer so every surface (skill-runner, TUI) can call them by name:
// MsgList / MsgPost / MsgAck and ChecklistList / ChecklistAdd /
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

export const msgListRuntime: ToolRuntime<Record<string, unknown>, MsgListResult> = {
  id: 'msg_list',
  spec: buildMsgListTool(),
  async run(req) { return observeLedgerCall('MsgList', req, () => dispatchMsgList(req), (a, r) => ({ to: a.to, ...(r ? { count: r.count, after: r.after } : {}) })); },
};

export const msgPostRuntime: ToolRuntime<Record<string, unknown>, MsgPostResult> = {
  id: 'msg_post',
  spec: buildMsgPostTool(),
  async run(req) { return observeLedgerCall('MsgPost', req, () => dispatchMsgPost(req), (a, r) => ({ from: a.from, to: a.to, ...(r ? { id: r.message.id } : {}) })); },
};

export const msgAckRuntime: ToolRuntime<Record<string, unknown>, MsgAckResult> = {
  id: 'msg_ack',
  spec: buildMsgAckTool(),
  async run(req) { return observeLedgerCall('MsgAck', req, () => dispatchMsgAck(req), (a, r) => ({ to: a.to, id: a.id, ...(r ? { cursor: r.cursor } : {}) })); },
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

export const ALL_OPS_LEDGER_RUNTIMES: ToolRuntime<any, any>[] = [
  msgListRuntime,
  msgPostRuntime,
  msgAckRuntime,
  checklistListRuntime,
  checklistAddRuntime,
  checklistSetRuntime,
  checklistEditRuntime,
  checklistMoveRuntime,
];
