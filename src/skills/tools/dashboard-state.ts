// ── GetDashboardState LLM tool ──
//
// On-demand structured pull of the full dashboard state snapshot.
// The system-prompt injection (runTurn) already front-loads this
// compact text, but tools like GetDashboardState let the LLM pull
// a fresh JSON when it wants to make state-conditioned decisions.
//
// Output is the DashboardStateSnapshot JSON. The `output` string
// is the same prompt-rendered summary (short), so when the model
// only glances at the tool_result preview it still sees the key
// facts; full structured state follows in the other fields.

import type { LLMToolSpec } from '../../llm.js';
import {
  captureDashboardState,
  renderDashboardStateForSystemPrompt,
  type DashboardStateSnapshot,
  type CaptureOpts,
} from '../../dashboard/runtime/state-snapshot.js';

export function buildGetDashboardStateTool(): LLMToolSpec {
  return {
    name: 'GetDashboardState',
    description:
      'Return the CURRENT monad-agent dashboard state: active PTY shells, terminal-modal sessions, the workspace cwd/remoteHost, and which tools are exposed this turn. ' +
      'State is usually stable within a turn; do not call it twice without an intervening action that could change sessions, cwd, or tool exposure. ' +
      'Read-only; no approval, no audit log.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  };
}

export interface DashboardStateResult extends Record<string, unknown> {
  /** Summary line the LLM sees first — same format as the system
   *  prompt injection. */
  output: string;
  snapshot: DashboardStateSnapshot;
}

export async function dispatchGetDashboardState(
  _args: Record<string, unknown>,
  deps: CaptureOpts = {},
): Promise<DashboardStateResult> {
  const snapshot = captureDashboardState(deps);
  return {
    output: renderDashboardStateForSystemPrompt(snapshot),
    snapshot,
  };
}
