import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { LLMToolSpec } from '../llm/tool-spec.js';
import { parsePluginManifest, type PluginAIToolRoute } from '../plugins/core/manifest.js';
import type { LLMToolDef } from '../plugins/core/types.js';
import { dispatchToolRoute, type ToolRouteMatch } from '../tool-router/index.js';
import { runAppDeploy } from '../agent/app-deploy-plugin.js';

const EXECUTABLE_NATIVE_HANDLERS = new Set(['native:logs_query', 'native:ops_status', 'native:release_status', 'native:app_deploy']);
const NON_EXECUTABLE_NATIVE_HANDLERS = new Set(['native:release_graph_start']);

interface NativePluginRouteTool extends LLMToolSpec {
  pluginId: string;
  handlerRef: string;
  route: PluginAIToolRoute;
}

export interface DashboardPluginRouteAdapter {
  classicHostTools(hostTools: readonly LLMToolDef[]): LLMToolDef[];
  nextHostTools(hostTools: readonly LLMToolDef[]): LLMToolDef[];
  dispatch(name: string, args: Record<string, unknown>, confirmed?: boolean): Promise<
    { ok: true; result: unknown } | { ok: false; error: string } | null
  >;
}

export interface DashboardPluginRouteBridge extends Omit<DashboardPluginRouteAdapter, 'dispatch'> {
  dispatch(name: string, args: Record<string, unknown>, confirmed?: boolean): Promise<
    { ok: true; result: unknown } | { ok: false; error: string }
  >;
}

/** Loads route-only first-party manifests and adapts their symbolic native targets for TUI turns. */
export function createDashboardPluginRouteAdapter(options: {
  pluginRoot: string;
  dispatchCore(name: string, args: Record<string, unknown>): Promise<unknown>;
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
      const result = await dispatch(tool, args as Record<string, unknown>);
      return result.ok ? result.result : { error: result.error };
    },
    pluginId: tool.pluginId,
    route: tool.route,
  });
  const routeTools = tools.map(asToolDef);
  const merge = (hostTools: readonly LLMToolDef[]) => {
    const names = new Set(hostTools.map((tool) => tool.name));
    shadowedNames = names;
    return [...hostTools, ...routeTools.filter((tool) => !names.has(tool.name))];
  };

  async function dispatch(tool: NativePluginRouteTool, args: Record<string, unknown>, confirmed = false) {
    if (NON_EXECUTABLE_NATIVE_HANDLERS.has(tool.handlerRef)) {
      return { ok: false as const, error: 'release graph start is disabled in this TUI adapter; approval boundary is OP-only' };
    }
    if (!EXECUTABLE_NATIVE_HANDLERS.has(tool.handlerRef)) {
      return { ok: false as const, error: `native plugin handler is not registered: ${tool.handlerRef}` };
    }
    if (tool.handlerRef === 'native:app_deploy') {
      return { ok: true as const, result: await runAppDeploy(args) };
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
    return { ok: true as const, result: await result.result };
  }

  return {
    classicHostTools: merge,
    nextHostTools: merge,
    async dispatch(name, args, confirmed = false) {
      if (shadowedNames.has(name)) return null;
      const tool = byName.get(name);
      return tool ? dispatch(tool, args, confirmed) : null;
    },
  };
}

function loadNativeRouteTools(pluginRoot: string): NativePluginRouteTool[] {
  if (!existsSync(pluginRoot)) return [];
  const tools: NativePluginRouteTool[] = [];
  for (const name of ['elanous-observe', 'elanous-release', 'elanous-app-deploy']) {
    const directory = join(pluginRoot, name);
    if (!existsSync(directory)) continue;
    if (!statSync(directory).isDirectory()) continue;
    const manifestPath = join(directory, 'plugin.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = parsePluginManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
    for (const contribution of manifest.contributes.aiTools ?? []) {
      if (!contribution.route || !contribution.handler?.startsWith('native:')) continue;
      tools.push({
        pluginId: manifest.id,
        name: contribution.name,
        description: contribution.description,
        parameters: contribution.parameters ?? { type: 'object', properties: {} },
        handlerRef: contribution.handler,
        route: contribution.route,
      });
    }
  }
  return tools;
}
