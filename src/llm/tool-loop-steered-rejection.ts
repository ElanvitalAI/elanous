export const STEERED_SHELL_APPROVAL_KEYS = new Set(['rejected:ops-ledger-cli', 'rejected:cd']);

export function isSteeredShellRejection(result: unknown): boolean {
  if (result === null || typeof result !== 'object') return false;
  const { approvalKey, exitCode, elapsedMs } = result as Record<string, unknown>;
  return typeof approvalKey === 'string'
    && STEERED_SHELL_APPROVAL_KEYS.has(approvalKey)
    && exitCode === null
    && elapsedMs === 0;
}

export const REPAIR_PHASE_READ_ONLY_OPS_TOOLS = ['MsgList', 'ChecklistList'] as const;

/** Operational built-ins every action phase must keep runnable (TUI-VERIFY-PHASE-MSG-TOOLS ·
 *  TUI-REPAIR-PHASE-DELEGATE-RESULT). Two dead ends this closes:
 *  - RunShell steers `eln msg …` / `eln release checklist …` to these native ledger tools
 *    (skills/tools/shell.ts LEDGER_CLI_NATIVE_TOOL), so any phase that allows RunShell but
 *    rejects the steer target loops forever (#62 repair · #67 verify — MsgPost).
 *  - Agent is allowed in every action phase, so its result (AgentOutput/AgentList) must be
 *    too, or a delegated result is dropped and the parent redoes the work (#41).
 *  Source edits stay governed by each phase's own Edit/Write entries — nothing here edits files. */
export const ACTION_PHASE_OPS_TOOLS = [
  'MsgList',
  'MsgPost',
  'MsgAck',
  'ChecklistList',
  'ChecklistAdd',
  'ChecklistSet',
  'ChecklistEdit',
  'ChecklistMove',
  'AgentOutput',
  'AgentList',
] as const;
