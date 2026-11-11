import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { LLMToolSpec } from '../llm/tool-spec.js';
import { parsePluginManifest, type PluginAIToolRoute } from '../plugins/core/manifest.js';
import type { LLMToolDef } from '../plugins/core/types.js';
import { dispatchToolRoute, type ToolRouteMatch } from '../tool-router/index.js';
import { runAppDeploy } from '../agent/app-deploy-plugin.js';
import type { ToolRuntimeContext } from '../tool-runtime/types.js';
import type { PluginRouteDispatchContract } from '../plugins/core/route-adapter.js';
import type { AcpAskPusher } from '../acp/acp-surface-channels.js';
import { createTuiDeployConfirmChannel, type TuiDeployApproval } from './runtime/tui-deploy-confirm-channel.js';
import type { InlineChoiceBroker } from '../tui/inline-choice.js';
import type { GraphRunOptions } from '../graph-runner/runner.js';

const EXECUTABLE_NATIVE_HANDLERS = new Set(['native:logs_query', 'native:ops_status', 'native:release_status', 'native:app_deploy']);
const NON_EXECUTABLE_NATIVE_HANDLERS = new Set(['native:release_graph_start']);

/** Preserve the originating ACP ask when present; otherwise confirm in the TUI itself. */
export function createDashboardTuiConfirmContext(
  sessionId: string | undefined,
  askPusher: AcpAskPusher | null,
  nativeApproval?: TuiDeployApproval,
  verifiedOwner?: ToolRuntimeContext['verifiedOwner'],
): Partial<ToolRuntimeContext> {
  const originatingAcp = sessionId && askPusher ? { sessionId, pusher: askPusher } : undefined;
  return {
    surface: 'tui',
    ...(sessionId ? { sessionId } : {}),
    ...(verifiedOwner ? { verifiedOwner } : {}),
    confirmChannels: [createTuiDeployConfirmChannel(nativeApproval, originatingAcp)],
  };
}

/** Resolve an owner only through the Nexus app-bound session endpoint; missing or invalid sessions stay anonymous. */
export async function resolveDashboardVerifiedOwner(input: {
  nexusUrl: string;
  appSlug?: string;
  sessionToken?: string;
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}): Promise<{ id: string } | undefined> {
  const token = input.sessionToken?.trim();
  const appSlug = input.appSlug?.trim();
  if (!token || (input.appSlug !== undefined && !appSlug)) return undefined;
  let endpoint: URL;
  try {
    endpoint = new URL(input.nexusUrl);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
    if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && loopback)) return undefined;
    endpoint.pathname = '/v1/members/owner';
    endpoint.search = appSlug ? new URLSearchParams({ appSlug }).toString() : '';
    endpoint.hash = '';
  } catch { return undefined; }
  try {
    const response = await (input.fetchImpl ?? fetch)(endpoint, {
      method: 'GET', headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return undefined;
    const body: unknown = await response.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
    const memberId = (body as Record<string, unknown>).memberId;
    return typeof memberId === 'string' && memberId.trim() ? { id: memberId.trim() } : undefined;
  } catch { return undefined; }
}

/** Ask for graph-route approval through the classic TUI's shared inline input slot. */
export async function requestDashboardGraphConfirmation(broker: InlineChoiceBroker, prompt: string): Promise<boolean> {
  const result = await broker.ask({
    id: `plugin-route-confirm-${crypto.randomUUID()}`,
    question: prompt,
    options: [{ value: 'y', label: 'y' }, { value: 'N', label: 'N' }],
    includeOther: false,
    yesNo: true,
  });
  return !('cancelled' in result) && result.selected.includes('y');
}

/** Production Graph v2 route executor shared by the classic dashboard and fake-owner PTY proof. */
export async function dispatchVerifiedDashboardGraph(
  graphFile: string,
  args: Record<string, unknown>,
  context: ToolRuntimeContext | undefined,
  runOptions: GraphRunOptions = {},
): Promise<import('../graph-runner/runner.js').GraphRunState> {
  const memberId = context?.verifiedOwner?.id;
  if (!memberId) throw new Error('graph route requires a verified owner context');
  const { runGraph } = await import('../graph-runner/runner.js');
  const graphDeclaration = parseYaml(readFileSync(graphFile, 'utf8')) as {
    graph?: { purpose?: unknown };
    nodes?: Array<{ type?: unknown }>;
  };
  const needsAsk = graphDeclaration.nodes?.some(node => node.type === 'make' || node.type === 'decide') === true;
  const graphPurpose = typeof graphDeclaration.graph?.purpose === 'string' ? graphDeclaration.graph.purpose : 'Run graph';
  const inputContext = args.context && typeof args.context === 'object' && !Array.isArray(args.context)
    ? args.context as Record<string, unknown>
    : {};
  const ask = typeof args.ask === 'string' && args.ask.trim() ? args.ask : graphPurpose;
  const graphRunId = runOptions.runId ?? crypto.randomUUID();
  const graphStartedAt = typeof inputContext.startedAt === 'string' ? inputContext.startedAt : new Date().toISOString();
  return runGraph(graphFile, {
    ...runOptions,
    runId: graphRunId,
    input: { ...args, ...(needsAsk ? { ask } : {}), context: { ...inputContext, memberId, runId: graphRunId, startedAt: graphStartedAt } },
    quiet: true,
  });
}

/** Bind test-world GraphRunOptions while retaining the production graph route callback. */
export function createDashboardGraphRouteDispatcher(
  runOptions: GraphRunOptions = {},
  requestGraphApproval?: (prompt: string) => Promise<boolean>,
) {
  return async (_pluginId: string, _graphId: string, graphFile: string, args: Record<string, unknown>, context?: ToolRuntimeContext) => {
    const { decideGraphApproval, runGraph } = await import('../graph-runner/runner.js');
  let state = await dispatchVerifiedDashboardGraph(graphFile, args, context, runOptions);
    while (state.status === 'awaiting-approval' && state.pending) {
      const approved = await requestGraphApproval?.(state.pending.message) ?? false;
      decideGraphApproval(state.graphId, state.runId, approved ? 'approved' : 'rejected', 'classic-tui', runOptions.deps?.root);
      const { runId: _runId, resumeRunId: _resumeRunId, resumeGraphId: _resumeGraphId, ...resumeOptions } = runOptions;
      state = await runGraph(graphFile, { ...resumeOptions, resumeRunId: state.runId, resumeGraphId: state.graphId });
    }
    return state;
  };
}

interface NativePluginRouteTool extends LLMToolSpec {
  pluginId: string;
  handlerRef: string;
  route: PluginAIToolRoute;
  graphFiles: Map<string, string>;
  confirmationPrompt?: string;
}

export interface DashboardPluginRouteAdapter extends PluginRouteDispatchContract {
  classicHostTools(hostTools: readonly LLMToolDef[]): LLMToolDef[];
  nextHostTools(hostTools: readonly LLMToolDef[]): LLMToolDef[];
}

export interface DashboardPluginRouteBridge extends Omit<DashboardPluginRouteAdapter, 'dispatch'> {
  dispatch(name: string, args: Record<string, unknown>, confirmed?: boolean, context?: ToolRuntimeContext): Promise<
    { ok: true; result: unknown } | { ok: false; error: string }
  >;
}

/** Loads route-only first-party manifests and adapts their symbolic native targets for TUI turns. */
export function createDashboardPluginRouteAdapter(options: {
  pluginRoot: string;
  dispatchCore(name: string, args: Record<string, unknown>): Promise<unknown>;
  /** Generic graph execution seam. Route authorization stays in the adapter; graph capabilities stay injected. */
  dispatchGraph?: (pluginId: string, graphId: string, graphFile: string, args: Record<string, unknown>, context?: ToolRuntimeContext) => Promise<unknown>;
  /** Non-modal TUI confirmation. Missing confirmation capability always fails closed. */
  requestConfirmation?: (prompt: string) => Promise<boolean>;
  dispatchAppDeploy?: (args: Record<string, unknown>, context?: ToolRuntimeContext) => Promise<unknown>;
  getTuiDispatchContext?: () => Partial<ToolRuntimeContext> | Promise<Partial<ToolRuntimeContext>>;
}): DashboardPluginRouteAdapter {
  const tools = loadNativeRouteTools(options.pluginRoot);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  let shadowedNames = new Set<string>();
  const asToolDef = (tool: NativePluginRouteTool): LLMToolDef => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    // Route-only manifests use symbolic handlers. The TUI adapter resolves those at dispatch time.
    handler: async (args) => {
      const context = await options.getTuiDispatchContext?.() as ToolRuntimeContext | undefined;
      const result = await dispatch(tool, args as Record<string, unknown>, false, context);
      return result.ok ? result.result : { error: result.error };
    },
    pluginId: tool.pluginId,
    route: tool.route,
    handlerRef: tool.handlerRef,
    ...(tool.handlerRef.startsWith('graph:') || tool.handlerRef.startsWith('./graph:')
      ? { allowedGraphIds: [...tool.graphFiles.keys()] } : {}),
  });
  const routeTools = tools.map(asToolDef);
  const routeToolDefs = new Set(routeTools);
  const merge = (hostTools: readonly LLMToolDef[]) => {
    const nativeHostTools = hostTools.filter((hostTool) => {
      const routeTool = byName.get(hostTool.name);
      // PluginHost may contribute its own copy of a built-in route tool. Prefer
      // the TUI adapter's wrapper for that same plugin so it can inject verified
      // session context before graph dispatch; unrelated host collisions still win.
      return !routeTool || routeToolDefs.has(hostTool) || hostTool.pluginId !== routeTool.pluginId;
    });
    const names = new Set(nativeHostTools.map((tool) => tool.name));
    // A caller may pass the catalog produced by an earlier merge back into this adapter.
    // Only independently supplied host tools shadow a declared route; our own route tool
    // definitions must remain dispatchable through the production bridge.
    shadowedNames = new Set(nativeHostTools.filter((tool) => !routeToolDefs.has(tool)).map((tool) => tool.name));
    return [...nativeHostTools, ...routeTools.filter((tool) => !names.has(tool.name))];
  };

  async function dispatch(tool: NativePluginRouteTool, args: Record<string, unknown>, confirmed = false, context?: ToolRuntimeContext) {
    if (NON_EXECUTABLE_NATIVE_HANDLERS.has(tool.handlerRef)) {
      return { ok: false as const, error: 'release graph start is disabled in this TUI adapter; approval boundary is OP-only' };
    }
    if (tool.handlerRef.startsWith('graph:') || tool.handlerRef.startsWith('./graph:')) {
      const graphId = tool.handlerRef.replace(/^(?:\.\/)?graph:/, '');
      const allowedGraphIds = new Set(tool.graphFiles.keys());
      const graphFile = tool.graphFiles.get(graphId);
      const executeGraph = options.dispatchGraph;
      if (!allowedGraphIds.has(graphId) || !graphFile) {
        return { ok: false as const, error: `graph route is not allowlisted: ${tool.name}` };
      }
      if (!executeGraph) return { ok: false as const, error: 'graph route executor is not configured' };
      const match: ToolRouteMatch = {
        pluginId: tool.pluginId, name: tool.name, route: tool.route, handler: tool.handlerRef,
        bm25: 0, ontology: 0, ontologyTerms: [], score: 0,
      };
      let approved = confirmed;
      if (tool.route.requiresConfirm && !approved) {
        try {
          approved = await (options.requestConfirmation?.(tool.confirmationPrompt ?? `Run ${tool.name}? (y/N)`) ?? Promise.resolve(false));
        } catch (error) {
          return { ok: false as const, error: `confirmation failed closed for ${tool.name}: ${String(error)}` };
        }
      }
      const result = dispatchToolRoute(match, approved, () => {
        return executeGraph(tool.pluginId, graphId, graphFile, args, context);
      }, { allowedGraphIds });
      if (result.status === 'confirmation-required') return { ok: false as const, error: `confirmation declined for ${tool.name}` };
      if (result.status === 'graph-not-allowlisted') return { ok: false as const, error: `graph route is not allowlisted: ${tool.name}` };
      try { return { ok: true as const, result: await result.result }; }
      catch (error) { return { ok: false as const, error: String(error) }; }
    }
    if (!EXECUTABLE_NATIVE_HANDLERS.has(tool.handlerRef)) {
      return { ok: false as const, error: `native plugin handler is not registered: ${tool.handlerRef}` };
    }
    if (tool.handlerRef === 'native:app_deploy') {
      const dispatchContext: ToolRuntimeContext = {
        surface: 'tui', ...await options.getTuiDispatchContext?.(), ...context,
      };
      return { ok: true as const, result: await (options.dispatchAppDeploy ?? runAppDeploy)(args, dispatchContext) };
    }
    const coreName = tool.handlerRef.slice('native:'.length);
    const match: ToolRouteMatch = {
      pluginId: tool.pluginId,
      name: tool.name,
      route: tool.route,
      bm25: 0,
      ontology: 0,
      ontologyTerms: [],
      score: 0,
    };
    const result = dispatchToolRoute(match, confirmed, (authorized) =>
      options.dispatchCore(authorized.name === tool.name ? coreName : '', args));
    if (result.status === 'confirmation-required') {
      return { ok: false as const, error: `confirmation required before dispatching ${tool.name}` };
    }
    if (result.status === 'graph-not-allowlisted') {
      return { ok: false as const, error: `graph route is not allowlisted: ${tool.name}` };
    }
    return { ok: true as const, result: await result.result };
  }

  return {
    classicHostTools: merge,
    nextHostTools: merge,
    async dispatch(name, args, confirmed = false, context) {
      if (shadowedNames.has(name)) return null;
      const tool = byName.get(name);
      return tool ? dispatch(tool, args, confirmed, context) : null;
    },
  };
}

function loadNativeRouteTools(pluginRoot: string): NativePluginRouteTool[] {
  if (!existsSync(pluginRoot)) return [];
  const tools: NativePluginRouteTool[] = [];
  let names: string[];
  try { names = readdirSync(pluginRoot); } catch { return []; }
  for (const name of names) {
    try {
    const directory = join(pluginRoot, name);
    if (!existsSync(directory)) continue;
    if (!statSync(directory).isDirectory()) continue;
    const manifestPath = join(directory, 'plugin.json');
    const yamlPath = join(directory, 'plugin.yaml');
    if (!existsSync(manifestPath) && !existsSync(yamlPath)) continue;
    let manifest: ReturnType<typeof parsePluginManifest>;
    let graphFiles = new Map<string, string>();
    let rawAiTools: Record<string, unknown>[] = [];
    if (existsSync(yamlPath)) {
      const raw = parseYaml(readFileSync(yamlPath, 'utf8')) as Record<string, unknown>;
      manifest = parsePluginManifest({ id: raw.id, name: raw.name, version: raw.version, contributes: raw.contributes });
      const rawContributes = raw.contributes as Record<string, unknown> | undefined;
      rawAiTools = Array.isArray(rawContributes?.aiTools) ? rawContributes.aiTools as Record<string, unknown>[] : [];
      graphFiles = graphFilesForAssets(directory, Array.isArray(raw.graphs) ? raw.graphs : []);
    } else {
      const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
      manifest = parsePluginManifest(raw);
      const rawContributes = raw.contributes as Record<string, unknown> | undefined;
      rawAiTools = Array.isArray(rawContributes?.aiTools) ? rawContributes.aiTools as Record<string, unknown>[] : [];
      const extensions = raw.extensions as Record<string, unknown> | undefined;
      const elanous = extensions?.['ai.elanous'] as Record<string, unknown> | undefined;
      graphFiles = graphFilesForAssets(directory, Array.isArray(elanous?.graphs) ? elanous.graphs : manifest.contributes.graphs ?? []);
    }
    for (const contribution of manifest.contributes.aiTools ?? []) {
      if (!contribution.route || !(contribution.handler?.startsWith('native:') || contribution.handler?.startsWith('graph:') || contribution.handler?.startsWith('./graph:'))) continue;
      const rawRoute = rawAiTools.find((entry) => entry.name === contribution.name)?.route as Record<string, unknown> | undefined;
      const rawConfirmation = rawRoute?.confirmation as Record<string, unknown> | undefined;
      tools.push({
        pluginId: manifest.id,
        name: contribution.name,
        description: contribution.description,
        parameters: contribution.parameters ?? { type: 'object', properties: {} },
        handlerRef: contribution.handler,
        route: contribution.route,
        graphFiles,
        confirmationPrompt: typeof rawConfirmation?.prompt === 'string'
          ? rawConfirmation.prompt
          : undefined,
      });
    }
    } catch {
      // One malformed, unreadable, or dangling plugin entry must not take down dashboard startup.
      continue;
    }
  }
  return tools;
}

export function graphFilesForAssets(pluginDir: string, assets: readonly unknown[]): Map<string, string> {
  const root = realpathSync(pluginDir);
  const graphs = new Map<string, string>();
  const seenIds = new Set<string>();
  for (const asset of assets) {
    if (typeof asset !== 'string' || isAbsolute(asset)) continue;
    const candidate = resolve(root, asset);
    const lexical = relative(root, candidate);
    if (lexical === '..' || lexical.startsWith(`..${sep}`) || isAbsolute(lexical) || !existsSync(candidate)) continue;
    const file = realpathSync(candidate);
    const actual = relative(root, file);
    if (actual === '..' || actual.startsWith(`..${sep}`) || isAbsolute(actual)) continue;
    try {
      const graph = parseYaml(readFileSync(file, 'utf8')) as Record<string, unknown>;
      const graphId = (graph.graph as Record<string, unknown> | undefined)?.id;
      if (typeof graphId === 'string') {
        if (seenIds.has(graphId)) {
          graphs.delete(graphId);
          continue;
        }
        seenIds.add(graphId);
        graphs.set(graphId, file);
      }
    } catch { /* Invalid graph assets stay out of the route allowlist. */ }
  }
  return graphs;
}
