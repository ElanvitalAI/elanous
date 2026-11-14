import type { LLMToolDef } from '../plugins/core/types.js';
import { BUILTIN_DIR, PluginHost } from '../plugins/core/host.js';
import { createPluginRouteAdapter } from '../plugins/core/route-adapter.js';
import { buildCoreTools } from '../domains/core-tools.js';
import { dispatchToolByName, getToolRuntime, listToolRuntimes, registerAllDefaultToolRuntimes } from '../tool-runtime/index.js';
import type { ToolRuntimeContext } from '../tool-runtime/types.js';
import type { GraphRunOptions } from '../graph-runner/runner.js';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Resolve only a declared graph route, using the graph CLI's trusted runner boundary. */
async function graphRouteForFile(graphFile: string, injected?: GraphRunOptions['deps']): Promise<{
  deps: GraphRunOptions['deps']; defaultAsk?: string;
}> {
  const graphPath = realpathSync(graphFile);
  const pluginRoot = resolve(dirname(graphPath), '..');
  const manifestPath = join(pluginRoot, 'plugin.json');
  if (!existsSync(manifestPath)) return { deps: injected };
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { extensions?: { 'ai.elanous'?: {
    graphs?: string[]; graphProviders?: Record<string, { module: string; factory: string; withPluginRoot?: boolean;
      defaultAsk?: string }> } } };
  const extension = manifest.extensions?.['ai.elanous'];
  const relativeGraph = relative(pluginRoot, graphPath).split(sep).join('/');
  if (!extension?.graphs?.some(graph => graph.replace(/^\.\//, '') === relativeGraph)) return { deps: injected };
  const declaration = extension.graphProviders?.[relativeGraph] ?? extension.graphProviders?.[`./${relativeGraph}`];
  if (!declaration) return { deps: injected };
  const defaultAsk = typeof declaration.defaultAsk === 'string' && declaration.defaultAsk.trim()
    ? declaration.defaultAsk : undefined;
  if (injected?.capabilityProviders) return { deps: injected, defaultAsk };
  const runnerRoot = realpathSync(resolve(import.meta.dir, '../graph-runner'));
  const modulePath = realpathSync(resolve(import.meta.dir, '../..', declaration.module));
  if (!modulePath.startsWith(`${runnerRoot}${sep}`)) throw new Error('plugin graph provider must use the shared graph runner');
  const module = await import(pathToFileURL(modulePath).href) as Record<string, unknown>;
  const factory = module[declaration.factory];
  if (typeof factory !== 'function') throw new Error(`plugin graph provider factory missing: ${declaration.factory}`);
  return { deps: { ...injected, capabilityProviders: declaration.withPluginRoot ? factory(pluginRoot) : factory() },
    defaultAsk };
}

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
  /** Fake model for the isolated default graph route; production uses the CLI model provider. */
  graphPrompt?: (prompt: string) => Promise<string>;
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
      const route = await graphRouteForFile(graphFile, options.graphDeps);
      const input = { ...args,
        ...(args.ask === undefined && route.defaultAsk ? { ask: route.defaultAsk } : {}),
        context: { ...inputContext, memberId: owner.id } };
      const deps = { ...route.deps, callLLM: route.deps?.callLLM ?? options.graphPrompt ?? (async (prompt: string) => {
        const { buildCliWorkflowDeps } = await import('./workflow.js');
        return buildCliWorkflowDeps().callLLM({ prompt });
      }) };
      const state = await runGraph(graphFile, { input, verifiedOwnerId: owner.id, quiet: true, ...(deps ? { deps } : {}) });
      if (state.status !== 'awaiting-approval' || !Object.hasOwn(args, 'ticketDesignPath')) return state;
      if (!options.requestConfirmation) throw new Error('Scene 5 approval surface is unavailable');
      const { scene5DecisionPromptFromGraph } = await import('../tui-client/scene5-decision-consumer.js');
      const prompt = scene5DecisionPromptFromGraph(state, graphId, args.ticketDesignPath);
      const approved = await options.requestConfirmation(prompt);
      const pendingNodeId = state.pending!.nodeId;
      decideGraphApproval(state.graphId, state.runId, approved ? 'approved' : 'rejected', owner.id,
        deps?.root, { nodeId: pendingNodeId, visit: state.path.filter(node => node === pendingNodeId).length });
      return runGraph(graphFile, { resumeRunId: state.runId, resumeGraphId: state.graphId, verifiedOwnerId: owner.id,
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
