import { withCapabilityDiscoveryDescription } from './capability-discovery.js';
import { APP_BUILD_PLUGIN_ID, appBuildDeclinedFailure } from './app-build-decline-guard.js';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { LLMToolSpec } from '../../llm/tool-spec.js';
import { parsePluginManifest, type PluginAIToolRoute } from './manifest.js';
import type { LLMToolDef } from './types.js';
import { dispatchToolRoute, type ToolRouteMatch } from '../../tool-router/index.js';
import { writeFileArtifact } from '../../tool-runtime/file-artifact.js';
import { runAppDeploy } from '../../agent/app-deploy-plugin.js';
import type { ToolRuntimeContext } from '../../tool-runtime/types.js';
import { autofillAppBuildArgs, isAppBuildRoute } from './app-build-autofill.js';

const EXECUTABLE_NATIVE_HANDLERS = new Set(['native:firecrawl', 'native:logs_query', 'native:ops_status', 'native:release_status', 'native:app_deploy', 'native:file_artifact_write']);
const NON_EXECUTABLE_NATIVE_HANDLERS = new Set(['native:release_graph_start']);

/** Host-issued authority, distinct from caller correlation context and tool arguments. */
export interface FileArtifactHostContext extends Partial<ToolRuntimeContext> {
  verifiedOwner: { id: string };
  fileArtifactAuthority: { ownerId: string; runId: string; approved: true };
}
export function isValidHostContext(value: unknown): value is FileArtifactHostContext {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const host = value as Record<string, unknown>;
    if (!Object.hasOwn(host, 'verifiedOwner') || !Object.hasOwn(host, 'fileArtifactAuthority')) return false;
    const owner = host.verifiedOwner;
    const authority = host.fileArtifactAuthority;
    if (!owner || typeof owner !== 'object' || Array.isArray(owner)
      || !authority || typeof authority !== 'object' || Array.isArray(authority)) return false;
    const who = owner as Record<string, unknown>;
    const grant = authority as Record<string, unknown>;
    const nonempty = (entry: unknown): entry is string => typeof entry === 'string' && entry.trim().length > 0;
    return Object.hasOwn(who, 'id') && nonempty(who.id)
      && ['ownerId', 'runId', 'approved'].every(key => Object.hasOwn(grant, key))
      && nonempty(grant.ownerId) && grant.ownerId === who.id
      && nonempty(grant.runId) && grant.approved === true;
  } catch { return false; }
}


interface NativePluginRouteTool extends LLMToolSpec {
  pluginId: string;
  handlerRef: string;
  route: PluginAIToolRoute;
  graphFiles: Map<string, string>;
  confirmationPrompt?: string;
}

export interface PluginRouteDispatchContract {
  dispatch(name: string, args: Record<string, unknown>, confirmed?: boolean, context?: ToolRuntimeContext): Promise<
    { ok: true; result: unknown } | { ok: false; error: string; code?: string } | null
  >;
}

export interface PluginRouteAdapter extends PluginRouteDispatchContract {
  hostTools(hostTools: readonly LLMToolDef[]): LLMToolDef[];
}

/** Shared route-only contract for classic and child CLI hosts. */
export function createPluginRouteAdapter(options: {
  pluginRoot: string;
  dispatchCore(name: string, args: Record<string, unknown>): Promise<unknown>;
  /** Generic graph execution seam. Route authorization stays in the adapter; graph capabilities stay injected. */
  dispatchGraph?: (pluginId: string, graphId: string, graphFile: string, args: Record<string, unknown>, context?: ToolRuntimeContext) => Promise<unknown>;
  /** Non-modal TUI confirmation. Missing confirmation capability always fails closed. */
  requestConfirmation?: (prompt: string) => Promise<boolean>;
  dispatchAppDeploy?: (args: Record<string, unknown>, context?: ToolRuntimeContext) => Promise<unknown>;
  getDispatchContext?: () => Partial<ToolRuntimeContext> | Promise<Partial<ToolRuntimeContext>>;
  /** APP-BUILD-LOCAL-PATH — host opt-in (local TUI/CLI only, never the daemon): app_build without a member
   *  connection builds in a local workspace instead of ending at needs_connection. */
  localAppBuild?: (args: Record<string, unknown>) => Promise<unknown>;
}): PluginRouteAdapter {
  const tools = loadNativeRouteTools(options.pluginRoot);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  let shadowedNames = new Set<string>();
  const asToolDef = (tool: NativePluginRouteTool): LLMToolDef => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    // Route-only manifests use symbolic handlers. The TUI adapter resolves those at dispatch time.
    handler: async (args) => {
      const context = await options.getDispatchContext?.() as ToolRuntimeContext | undefined;
      const result = await dispatch(tool, args as Record<string, unknown>, false, context);
      return result.ok ? result.result : { error: result.error, ...(result.code ? { code: result.code } : {}) };
    },
    pluginId: tool.pluginId,
    route: tool.route,
    handlerRef: tool.handlerRef,
    ...(tool.handlerRef.startsWith('graph:') || tool.handlerRef.startsWith('./graph:')
      ? { allowedGraphIds: [...tool.graphFiles.keys()] } : {}),
  });
  const routeTools = tools.map(asToolDef);
  const merge = (hostTools: readonly LLMToolDef[]) => {
    const names = new Set(hostTools.map((tool) => tool.name));
    shadowedNames = names;
    return [...hostTools, ...routeTools.filter((tool) => !names.has(tool.name))];
  };

  async function dispatch(tool: NativePluginRouteTool, args: Record<string, unknown>, confirmed = false,
    context?: ToolRuntimeContext): Promise<{ ok: true; result: unknown } | { ok: false; error: string; code?: string }> {
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
      let graphArgs = args;
      if (isAppBuildRoute(tool.pluginId, tool.name)) {
        // ONE-LINE-INTENT-CONTEXT-AUTOFILL: slot, handle source and data needs come from the verified
        // member context and the line, before any confirmation; a missing binding stays needs_connection.
        const filled = autofillAppBuildArgs(args, context);
        if (filled.status === 'needs_connection' && options.localAppBuild && typeof args.ask === 'string' && args.ask.trim()) {
          try { return { ok: true as const, result: await options.localAppBuild(args) }; }
          catch (error) { return { ok: false as const, error: `local app build failed: ${String(error)}` }; }
        }
        if (filled.status !== 'filled') return { ok: false as const, error: filled.error, code: filled.code };
        graphArgs = filled.args;
      }
      if (!context?.verifiedOwner?.id) {
        return { ok: false as const, error: 'graph route requires a verified owner context' };
      }
      // Source: tool-router ToolRouteMatch score fields are inert for an exact declared-name dispatch.
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
        return executeGraph(tool.pluginId, graphId, graphFile, graphArgs, context);
      }, { allowedGraphIds });
      if (result.status === 'confirmation-required') return { ok: false as const, error: `confirmation declined for ${tool.name}` };
      if (result.status === 'graph-not-allowlisted') return { ok: false as const, error: `graph route is not allowlisted: ${tool.name}` };
      try { return { ok: true as const, result: await result.result }; }
      catch (error) { return { ok: false as const, error: String(error) }; }
    }
    if (!EXECUTABLE_NATIVE_HANDLERS.has(tool.handlerRef)) {
      return { ok: false as const, error: `native plugin handler is not registered: ${tool.handlerRef}` };
    }
    if (tool.handlerRef === 'native:file_artifact_write') {
      let hostContext: Partial<ToolRuntimeContext> | undefined;
      try { hostContext = await options.getDispatchContext?.(); }
      catch { return { ok: false as const, error: 'file artifact creation context unavailable' }; }
      // The hint names only what this host actually offers: the local path exists only where the host opted in.
      if (!isValidHostContext(hostContext)) return { ok: false as const, error: options.localAppBuild
        ? 'file artifact creation context required: app_create writes only inside a member app_build run. Without a member connection call app_build — it builds in a local workspace and returns the folder to edit with Write.'
        : 'file artifact creation context required: app_create writes only inside a member app_build run (eln member connect).' };
      // A caller cannot supply missing host authority or downgrade its approval requirement.
      const effectiveContext = { ...hostContext, ...context };
      const approvalRequired = hostContext?.requireApproval === true || effectiveContext.requireApproval === true;
      if (approvalRequired && !confirmed) return { ok: false as const, error: 'file artifact creation requires approval in this context' };
      try { return { ok: true as const, result: writeFileArtifact(args) }; }
      catch { return { ok: false as const, error: 'file artifact creation failed: invalid input or destination unavailable' }; }
    }
    if (tool.handlerRef === 'native:app_deploy') {
      const dispatchContext: ToolRuntimeContext = {
        surface: 'tui', ...options.getDispatchContext?.(), ...context,
      };
      return { ok: true as const, result: await (options.dispatchAppDeploy ?? runAppDeploy)(args, dispatchContext) };
    }
    const coreName = tool.handlerRef.slice('native:'.length);
    // Source: tool-router ToolRouteMatch score fields are inert for an exact declared-name dispatch.
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
    hostTools: merge,
    async dispatch(name, args, confirmed = false, context) {
      if (shadowedNames.has(name)) return null;
      const tool = byName.get(name);
      if (!tool) return null;
      const result = await dispatch(tool, args, confirmed, context);
      // APP-BUILD-DECLINE-NO-BYPASS-DEPLOY: a declined or unanswered app_build confirmation is an
      // owner decision; the model gets an explicit structured result, not a bare error string.
      if (!result.ok && tool.pluginId === APP_BUILD_PLUGIN_ID && tool.route.requiresConfirm
        && (result.error === `confirmation declined for ${tool.name}`
          || result.error.startsWith(`confirmation failed closed for ${tool.name}:`))) {
        const declined = appBuildDeclinedFailure(tool.name,
          result.error.startsWith('confirmation failed closed') ? 'confirmation-failed' : 'declined');
        return declined;
      }
      return result;
    },
  };
}

function loadNativeRouteTools(pluginRoot: string): NativePluginRouteTool[] {
  if (!existsSync(pluginRoot)) return [];
  const tools: NativePluginRouteTool[] = [];
  for (const name of readdirSync(pluginRoot)) {
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
      // LOOP-AGENTS-AS-PLUGINS P3: a loop-agent plugin (plugin.yaml `loopAgent:`) contributes a trigger, never a route tool
      if (raw.loopAgent !== undefined) continue;
      manifest = parsePluginManifest({ id: raw.id, name: raw.name, version: raw.version, contributes: raw.contributes,
        ...(raw.whenToUse === undefined ? {} : Object.fromEntries(
          ['description', 'whenToUse', 'inputs', 'outputs', 'examples', 'requires'].map(key => [key, raw[key]]))),
      });
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
        description: withCapabilityDiscoveryDescription(contribution.description, manifest),
        parameters: contribution.parameters ?? { type: 'object', properties: {} },
        handlerRef: contribution.handler,
        route: contribution.route,
        graphFiles,
        confirmationPrompt: typeof rawConfirmation?.prompt === 'string'
          ? rawConfirmation.prompt
          : undefined,
      });
    }
  }
  return tools;
}

function graphFilesForAssets(pluginDir: string, assets: readonly unknown[]): Map<string, string> {
  const root = realpathSync(pluginDir);
  const graphs = new Map<string, string>();
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
      if (typeof graphId === 'string' && !graphs.has(graphId)) graphs.set(graphId, file);
      else if (typeof graphId === 'string') graphs.delete(graphId);
    } catch { /* Invalid graph assets stay out of the route allowlist. */ }
  }
  return graphs;
}
