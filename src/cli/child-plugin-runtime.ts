import type { LLMToolDef } from '../plugins/core/types.js';
import { BUILTIN_DIR, PluginHost } from '../plugins/core/host.js';
import { createPluginRouteAdapter } from '../plugins/core/route-adapter.js';
import { buildCoreTools } from '../domains/core-tools.js';
import { dispatchToolByName, getToolRuntime, listToolRuntimes, registerAllDefaultToolRuntimes } from '../tool-runtime/index.js';
import type { ToolRuntimeContext } from '../tool-runtime/types.js';

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
  requestConfirmation?: (prompt: string) => Promise<boolean>;
  dispatchGraph?: (pluginId: string, graphId: string, graphFile: string, args: Record<string, unknown>, context?: ToolRuntimeContext) => Promise<unknown>;
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
  const routes = createPluginRouteAdapter({
    pluginRoot: options.pluginRoot ?? BUILTIN_DIR,
    dispatchCore: (name, args) => core.dispatch(name, args),
    dispatchGraph: options.dispatchGraph ?? (async (_pluginId, _graphId, graphFile, args, dispatchContext) => {
      const owner = dispatchContext?.verifiedOwner;
      if (!owner?.id) throw new Error('graph route requires a verified owner context');
      const { runGraph } = await import('../graph-runner/runner.js');
      const inputContext = args.context && typeof args.context === 'object' && !Array.isArray(args.context)
        ? args.context as Record<string, unknown> : {};
      return runGraph(graphFile, { input: { ...args, context: { ...inputContext, memberId: owner.id } }, quiet: true });
    }),
    requestConfirmation: options.requestConfirmation,
    getDispatchContext: () => context,
  });
  const hostTools = routes.hostTools(host.hostLLMTools());
  const runtimeTools = listToolRuntimes('tui');
  return {
    hostTools,
    runtimeTools,
    getToolRuntime,
    dispatchToolRuntime: (name, args, signal) => dispatchToolByName(name, args, { ...context, signal }),
    dispatchPluginTool: async (name, args) => await routes.dispatch(name, args, false, context) ?? host.dispatchTool(name, args),
  };
}
