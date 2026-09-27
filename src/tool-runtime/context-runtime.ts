// ── Context tool runtimes — Phase C wiring ──
//
// Each context.* LLM tool gets its own ToolRuntime entry so surface
// filtering (skill vs dashboard vs mcp) and approval gating stay per-
// tool. All read-only → no approver slot used.
//
// Shared deps (cwd/remoteHost, session getter) flow through a DI record
// set at dashboard boot. Skills call this with {} and still receive
// useful answers from ambient workspace/tools/ptys/events state.

import {
  buildContextTools,
  dispatchContextWorkspace,
  dispatchContextPtysList,
  dispatchContextPtyDetail,
  dispatchContextSessionsList,
  dispatchContextWidgetsList,
  dispatchContextPluginsList,
  dispatchContextToolsList,
  dispatchContextEventsTail,
  dispatchContextBootstrap,
  type ContextDeps,
} from '../skills/tools/context.js';
import type { ToolRuntime } from './types.js';

let deps: ContextDeps = {};

/** Dashboard boot wires cwd/remote/session here so context tools see
 *  the live rig. Skills still get ambient workspace/tools/ptys/events. */
export function setContextRuntimeDeps(next: ContextDeps): void {
  deps = { ...next };
}

function asRuntime<Req extends Record<string, unknown>>(
  id: string,
  name: string,
  fn: (req: Req, deps?: ContextDeps) => Promise<unknown>,
): ToolRuntime<Req, any> {
  const spec = buildContextTools().find(tool => tool.name === name);
  if (!spec) throw new Error(`missing context tool spec: ${name}`);
  return {
    id,
    spec,
    async run(req) {
      return fn(req, deps) as Promise<any>;
    },
  };
}

export const contextWorkspaceRuntime    = asRuntime('context_workspace',     'ContextWorkspace',     dispatchContextWorkspace);
export const contextPtysListRuntime     = asRuntime('context_ptys_list',     'ContextPtysList',      dispatchContextPtysList);
export const contextPtyDetailRuntime    = asRuntime('context_pty_detail',    'ContextPtyDetail',      dispatchContextPtyDetail);
export const contextSessionsListRuntime = asRuntime('context_sessions_list', 'ContextSessionsList',   dispatchContextSessionsList);
export const contextWidgetsListRuntime  = asRuntime('context_widgets_list',  'ContextWidgetsList',    dispatchContextWidgetsList);
export const contextPluginsListRuntime  = asRuntime('context_plugins_list',  'ContextPluginsList',    dispatchContextPluginsList);
export const contextToolsListRuntime    = asRuntime('context_tools_list',    'ContextToolsList',      dispatchContextToolsList);
export const contextEventsTailRuntime   = asRuntime('context_events_tail',   'ContextEventsTail',     dispatchContextEventsTail);
export const contextBootstrapRuntime    = asRuntime('context_bootstrap',     'ContextBootstrap',      dispatchContextBootstrap);

export const ALL_CONTEXT_RUNTIMES: ToolRuntime<any, any>[] = [
  contextWorkspaceRuntime,
  contextPtysListRuntime,
  contextPtyDetailRuntime,
  contextSessionsListRuntime,
  contextWidgetsListRuntime,
  contextPluginsListRuntime,
  contextToolsListRuntime,
  contextEventsTailRuntime,
  contextBootstrapRuntime,
];
