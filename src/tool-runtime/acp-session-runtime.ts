// AXON P1 — ToolRuntime wrappers for the three AcpSession* tools.
//
// Minimal shape: catalog id → spec + dispatcher. The tool layer itself
// owns validation, so the runtime is a thin adapter.

import {
  buildAcpSessionCancelTool,
  buildAcpSessionCloseTool,
  buildAcpSessionCreateTool,
  buildAcpSessionJoinTool,
  buildAcpSessionListTool,
  buildAcpSessionResumeTool,
  buildAcpSessionSendTool,
  buildAcpSessionSpawnSubTool,
  buildAcpSessionStartBackgroundTool,
  buildAcpSessionStatusTool,
  buildAcpPlanThenExecuteTool,
  dispatchAcpSessionCancel,
  dispatchAcpSessionClose,
  dispatchAcpSessionCreate,
  dispatchAcpSessionJoin,
  dispatchAcpSessionList,
  dispatchAcpSessionResume,
  dispatchAcpSessionSend,
  dispatchAcpSessionSpawnSub,
  dispatchAcpSessionStartBackground,
  dispatchAcpSessionStatus,
  dispatchAcpPlanThenExecute,
  type AcpSessionCancelArgs,
  type AcpSessionCloseArgs,
  type AcpSessionCreateArgs,
  type AcpSessionJoinArgs,
  type AcpSessionListArgs,
  type AcpSessionResumeArgs,
  type AcpSessionSendArgs,
  type AcpSessionSpawnSubArgs,
  type AcpSessionStartBackgroundArgs,
  type AcpPlanThenExecuteArgs,
  type AcpSessionStatusArgs,
} from '../skills/tools/acp-session.js';
import type { ToolRuntime, ToolRuntimeContext } from './types.js';
import { assertClaudeSubscriptionAllowed } from '../policy/claude-subscription-guard.js';

function assertBackendAllowed(backendId: string, ctx: ToolRuntimeContext): void {
  assertClaudeSubscriptionAllowed({ origin: ctx.requestOrigin ?? 'owner', backendId, surface: ctx.surface });
}

function assertSessionAllowed(sessionId: string, ctx: ToolRuntimeContext): void {
  const backendId = /^acp-cli:([^:]+):/.exec(sessionId)?.[1];
  if (backendId) assertBackendAllowed(backendId, ctx);
}

// Output types are widened to `any` the way other multi-field runtimes
// (context-runtime, control-runtime, ...) do — ToolRunResult's union
// of `{output:string} | Record<string,unknown>` doesn't accept typed
// interfaces directly, and the dispatch result is surfaced to the LLM
// as JSON either way.

export const acpSessionCreateRuntime: ToolRuntime<AcpSessionCreateArgs, any> = {
  id: 'acp_session_create',
  spec: buildAcpSessionCreateTool(),
  async run(req, ctx) {
    assertBackendAllowed(req.brand, ctx);
    if (req.parentSessionId) assertSessionAllowed(req.parentSessionId, ctx);
    return dispatchAcpSessionCreate(req);
  },
};

export const acpSessionSendRuntime: ToolRuntime<AcpSessionSendArgs, any> = {
  id: 'acp_session_send',
  spec: buildAcpSessionSendTool(),
  async run(req, ctx) {
    assertSessionAllowed(req.sessionId, ctx);
    return dispatchAcpSessionSend(req);
  },
};

export const acpSessionCloseRuntime: ToolRuntime<AcpSessionCloseArgs, any> = {
  id: 'acp_session_close',
  spec: buildAcpSessionCloseTool(),
  async run(req) {
    return dispatchAcpSessionClose(req);
  },
};

// H2 #5 — persistence LLM tools.
export const acpSessionListRuntime: ToolRuntime<AcpSessionListArgs, any> = {
  id: 'acp_session_list',
  spec: buildAcpSessionListTool(),
  async run(req) {
    return dispatchAcpSessionList(req);
  },
};

export const acpSessionResumeRuntime: ToolRuntime<AcpSessionResumeArgs, any> = {
  id: 'acp_session_resume',
  spec: buildAcpSessionResumeTool(),
  async run(req, ctx) {
    assertSessionAllowed(req.sessionId, ctx);
    return dispatchAcpSessionResume(req);
  },
};

// H3 #7 — subagent spawning one-shot helper.
export const acpSessionSpawnSubRuntime: ToolRuntime<AcpSessionSpawnSubArgs, any> = {
  id: 'acp_session_spawn_sub',
  spec: buildAcpSessionSpawnSubTool(),
  async run(req, ctx) {
    assertBackendAllowed(req.brand, ctx);
    assertSessionAllowed(req.parentSessionId, ctx);
    return dispatchAcpSessionSpawnSub(req);
  },
};

// Plan/Execute Bridge P4-B — bundled plan-then-execute helper.
export const acpPlanThenExecuteRuntime: ToolRuntime<AcpPlanThenExecuteArgs, any> = {
  id: 'acp_plan_then_execute',
  spec: buildAcpPlanThenExecuteTool(),
  async run(req, ctx) {
    assertBackendAllowed(req.brand, ctx);
    assertBackendAllowed(req.executeBrand ?? req.brand, ctx);
    assertSessionAllowed(req.parentSessionId, ctx);
    return dispatchAcpPlanThenExecute(req);
  },
};

// H3 #6 — background agent lifecycle tools.
export const acpSessionStartBackgroundRuntime: ToolRuntime<AcpSessionStartBackgroundArgs, any> = {
  id: 'acp_session_start_background',
  spec: buildAcpSessionStartBackgroundTool(),
  async run(req, ctx) {
    assertBackendAllowed(req.brand, ctx);
    if (req.parentSessionId) assertSessionAllowed(req.parentSessionId, ctx);
    return dispatchAcpSessionStartBackground(req);
  },
};

export const acpSessionStatusRuntime: ToolRuntime<AcpSessionStatusArgs, any> = {
  id: 'acp_session_status',
  spec: buildAcpSessionStatusTool(),
  async run(req) {
    return dispatchAcpSessionStatus(req);
  },
};

export const acpSessionCancelRuntime: ToolRuntime<AcpSessionCancelArgs, any> = {
  id: 'acp_session_cancel',
  spec: buildAcpSessionCancelTool(),
  async run(req) {
    return dispatchAcpSessionCancel(req);
  },
};

export const acpSessionJoinRuntime: ToolRuntime<AcpSessionJoinArgs, any> = {
  id: 'acp_session_join',
  spec: buildAcpSessionJoinTool(),
  async run(req) {
    return dispatchAcpSessionJoin(req);
  },
};

// Typed as `ToolRuntime<any, any>[]` (not readonly tuple) so the
// registry loop at `src/tool-runtime/index.ts` can iterate without
// triggering the tuple-union-vs-generic mismatch the other `ALL_*`
// exports exhibit. Content is effectively frozen — mutation paths
// don't exist outside of tests.
export const ACP_SESSION_RUNTIMES: ReadonlyArray<ToolRuntime<any, any>> = [
  acpSessionCreateRuntime,
  acpSessionSendRuntime,
  acpSessionCloseRuntime,
  acpSessionListRuntime,
  acpSessionResumeRuntime,
  acpSessionSpawnSubRuntime,
  acpSessionStartBackgroundRuntime,
  acpSessionStatusRuntime,
  acpSessionCancelRuntime,
  acpSessionJoinRuntime,
  acpPlanThenExecuteRuntime,
];
