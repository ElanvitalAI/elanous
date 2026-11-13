import type { LLMToolDef } from '../plugins/core/types.js';
import { BUILTIN_DIR, PluginHost } from '../plugins/core/host.js';
import { createPluginRouteAdapter } from '../plugins/core/route-adapter.js';
import { buildCoreTools } from '../domains/core-tools.js';
import { dispatchToolByName, getToolRuntime, listToolRuntimes, registerAllDefaultToolRuntimes } from '../tool-runtime/index.js';
import type { ToolRuntimeContext } from '../tool-runtime/types.js';
import type { GraphRunOptions } from '../graph-runner/runner.js';

/** The same catalog and dispatch seams used by the classic PluginHost route bridge. */
export interface ChildPluginRuntimeContract {
  hostTools: readonly LLMToolDef[];
  runtimeTools: ReturnType<typeof listToolRuntimes>;
  getToolRuntime: typeof getToolRuntime;
  dispatchToolRuntime(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  dispatchPluginTool(name: string, args: Record<string, unknown>): Promise<
    { ok: true; result: unknown } | { ok: false; error: string }
  >;
}

export interface ChildPluginRuntimeOptions {
  pluginRoot?: string;
  verifiedOwner?: ToolRuntimeContext['verifiedOwner'];
  resolveVerifiedOwner?: () => Promise<ToolRuntimeContext['verifiedOwner'] | undefined>;
  requestConfirmation?: (prompt: string) => Promise<boolean>;
  dispatchGraph?: (pluginId: string, graphId: string, graphFile: string, args: Record<string, unknown>, context?: ToolRuntimeContext) => Promise<unknown>;
  /** Isolated graph provider/root for an actual-runner test world. */
  graphDeps?: GraphRunOptions['deps'];
}

export function createChildPluginRuntimeContract(options: ChildPluginRuntimeOptions = {}): ChildPluginRuntimeContract {
  registerAllDefaultToolRuntimes({ mcpLazyBoot: true });
  const host = new PluginHost({
    log: () => {}, hudSet: () => {}, requestRender: () => {}, focusPane: () => {},
  });
  const core = buildCoreTools();
  for (const spec of core.specs) {
    host.registerHostTool({
      name: spec.name, description: spec.description, parameters: spec.parameters,
      handler: (args) => core.dispatch(spec.name, args as Record<string, unknown>),
    });
  }
  const context: ToolRuntimeContext = { surface: 'tui', ...(options.verifiedOwner ? { verifiedOwner: options.verifiedOwner } : {}) };
  const dispatchContext = async (): Promise<ToolRuntimeContext> => ({ ...context,
    ...(options.resolveVerifiedOwner ? { verifiedOwner: await options.resolveVerifiedOwner() } : {}),
  });
  const routes = createPluginRouteAdapter({
    pluginRoot: options.pluginRoot ?? BUILTIN_DIR,
    dispatchCore: (name, args) => core.dispatch(name, args),
    dispatchGraph: options.dispatchGraph ?? (async (_pluginId, graphId, graphFile, args, dispatchContext) => {
      const owner = dispatchContext?.verifiedOwner;
      if (!owner?.id) throw new Error('graph route requires a verified owner context');
      const { decideGraphApproval, runGraph } = await import('../graph-runner/runner.js');
      const inputContext = args.context && typeof args.context === 'object' && !Array.isArray(args.context)
        ? args.context as Record<string, unknown> : {};
      const input = { ...args, context: { ...inputContext, memberId: owner.id } };
      const deps = options.graphDeps;
      const state = await runGraph(graphFile, { input, quiet: true, ...(deps ? { deps } : {}) });
      if (state.status !== 'awaiting-approval' || !Object.hasOwn(args, 'ticketDesignPath')) return state;
      if (!options.requestConfirmation) throw new Error('Scene 5 approval surface is unavailable');
      const { scene5DecisionPromptFromGraph } = await import('../tui-client/scene5-decision-consumer.js');
      const prompt = scene5DecisionPromptFromGraph(state, graphId, args.ticketDesignPath);
      const approved = await options.requestConfirmation(prompt);
      const pendingNodeId = state.pending!.nodeId;
      decideGraphApproval(state.graphId, state.runId, approved ? 'approved' : 'rejected', owner.id,
        deps?.root, { nodeId: pendingNodeId, visit: state.path.filter(node => node === pendingNodeId).length });
      return runGraph(graphFile, { resumeRunId: state.runId, resumeGraphId: state.graphId,
        quiet: true, ...(deps ? { deps } : {}) });
    }),
    requestConfirmation: options.requestConfirmation,
    getDispatchContext: dispatchContext,
  });
  const hostTools = routes.hostTools(host.hostLLMTools());
  const runtimeTools = listToolRuntimes('tui');
  return {
    hostTools,
    runtimeTools,
    getToolRuntime,
    dispatchToolRuntime: (name, args, signal) => dispatchToolByName(name, args, { ...context, signal }),
    dispatchPluginTool: async (name, args) => await routes.dispatch(name, args, false, await dispatchContext()) ?? host.dispatchTool(name, args),
  };
}
