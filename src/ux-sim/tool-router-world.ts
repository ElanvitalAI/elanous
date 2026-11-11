import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parsePluginManifest } from '../plugins/core/manifest.js';
import type { LLMToolSpec } from '../llm/tool-spec.js';
import { applyDeferredTools } from '../session-runtime/tier-flip.js';
import { dispatchToolSearch } from '../skills/tools/tool-search.js';
import {
  buildToolRouteIndex,
  defaultToolRoutingStrategy,
  dispatchToolRoute,
  routeToolIntentWithFallback,
  type SafeToolRouteDecision,
} from '../tool-router/index.js';

export interface ToolRouterWorldReceipt {
  defaultRoute: SafeToolRouteDecision;
  explicitNativeAll: SafeToolRouteDecision;
  disabledPlugin: SafeToolRouteDecision;
  failedIndex: SafeToolRouteDecision;
  indexLoads: number;
  firstPartyPluginIds: string[];
  ontologyPluginIds: string[];
  appDeployRoute: SafeToolRouteDecision;
  appDeployBlocked: boolean;
  appDeployHandlerCalls: number;
  multiActive: SafeToolRouteDecision;
  inactiveAppDeploy: SafeToolRouteDecision;
  multiActiveFallback: SafeToolRouteDecision;
  inactiveRouteSearchMatches: string[];
  inactiveSelectUnknown: string[];
  inactiveWarmPreloads: number;
  inactiveNativeAllActive: string[];
  providerRouteSchemas: string[];
  nativeAllProviderRouteSchemas: string[];
  disabledProviderRouteSchemas: string[];
  activeRouteSearchMatches: string[];
  activeRouteSelectMatches: string[];
  graphAllowlist: { handler: string | undefined; denied: string; missing: string; malformed: string; unconfirmed: string; allowed: string; dotted: string; calls: number };
  runtime: { defaultActive: string[]; nativeAllActive: string[]; defaultDeferred: string[] };
}

/** Manifest-only replay: no plugin handler, release service, or network is called. */
export function runToolRouterWorld(repoRoot = process.cwd()): ToolRouterWorldReceipt {
  const pluginRoot = join(repoRoot, 'plugins');
  const sources = readdirSync(pluginRoot).sort().flatMap((name) => {
    const path = join(pluginRoot, name, 'plugin.json');
    if (!existsSync(path)) return [];
    const manifest = parsePluginManifest(JSON.parse(readFileSync(path, 'utf8')));
    const tools = (manifest.contributes.aiTools ?? []).filter((tool) => tool.route);
    return tools.length > 0 ? [{ pluginId: manifest.id, tools }] : [];
  });
  const pluginIds = sources.map(({ pluginId }) => pluginId);
  let indexLoads = 0;
  const loadIndex = () => {
    indexLoads += 1;
    return buildToolRouteIndex(sources);
  };
  const enabledPluginIds = new Set(pluginIds);
  const defaultRoute = routeToolIntentWithFallback('로그 보여줘', loadIndex, {
    enabledPluginIds, strategy: defaultToolRoutingStrategy(),
  });
  const explicitNativeAll = routeToolIntentWithFallback('로그 보여줘', loadIndex, {
    enabledPluginIds, strategy: defaultToolRoutingStrategy('native-all'),
  });
  const disabledPlugin = routeToolIntentWithFallback('로그 보여줘', loadIndex, { enabledPluginIds: new Set(['elanous-release']) });
  const failedIndex = routeToolIntentWithFallback('로그 보여줘', () => { throw new Error('simulated index failure'); }, { enabledPluginIds: new Set(['elanous-release']) });
  const appDeployRoute = routeToolIntentWithFallback('강의 노트 스크랩 앱 배포해줘', loadIndex, { enabledPluginIds });
  const activePluginIds = new Set(sources.filter(({ tools }) =>
    tools.some(({ name }) => name === 'ObserveLogs' || name === 'ReleaseStatus')).map(({ pluginId }) => pluginId));
  const multiActive = routeToolIntentWithFallback('발행 로그', loadIndex, { enabledPluginIds, activePluginIds });
  const inactiveAppDeploy = routeToolIntentWithFallback('강의 노트 스크랩 앱 배포해줘', loadIndex, { enabledPluginIds, activePluginIds });
  const multiActiveFallback = routeToolIntentWithFallback('발행 로그', () => { throw new Error('simulated index failure'); },
    { enabledPluginIds, activePluginIds });
  let appDeployHandlerCalls = 0;
  const appDeployBlocked = appDeployRoute.matches[0]
    ? dispatchToolRoute(appDeployRoute.matches[0], false, () => { appDeployHandlerCalls += 1; }).status === 'confirmation-required'
    : false;
  const graphRoute = {
    triggers: ['run graph'], examples: [], sideEffects: 'external' as const,
    risk: 'high' as const, cost: 'spawns-run' as const, requiresConfirm: true,
  };
  const graphPluginId = 'fixture-graph';
  const allowedGraphIds = new Set(['declared']);
  const graphIndex = buildToolRouteIndex([{ pluginId: graphPluginId, tools: [
    { name: 'RunDeclaredGraph', description: 'Run declared graph', handler: 'graph:declared', route: graphRoute },
  ] }], { allowedGraphIdsByPlugin: new Map([[graphPluginId, allowedGraphIds]]) });
  const graphMatch = routeToolIntentWithFallback('run graph', () => graphIndex,
    { enabledPluginIds: new Set([graphPluginId]), allowedGraphIds }).matches[0];
  if (!graphMatch) throw new Error('declared graph route missing');
  let graphCalls = 0;
  const executeGraph = () => { graphCalls += 1; return 'executed'; };
  const graphAllowlist = {
    handler: graphMatch.handler,
    denied: dispatchToolRoute(graphMatch, true, executeGraph, { allowedGraphIds: new Set(['other']) }).status,
    missing: dispatchToolRoute(graphMatch, true, executeGraph).status,
    malformed: dispatchToolRoute({ ...graphMatch, handler: 'graph:../secret' }, true, executeGraph,
      { allowedGraphIds: new Set(['../secret']) }).status,
    unconfirmed: dispatchToolRoute(graphMatch, false, executeGraph, { allowedGraphIds }).status,
    allowed: dispatchToolRoute(graphMatch, true, executeGraph, { allowedGraphIds }).status,
    dotted: dispatchToolRoute({ ...graphMatch, handler: 'graph:report.v2' }, true, executeGraph,
      { allowedGraphIds: new Set(['report.v2']) }).status,
    calls: graphCalls,
  };
  const specs: LLMToolSpec[] = sources.flatMap(({ pluginId, tools }) => tools.filter((tool) => tool.route).map((tool) => ({
    name: tool.name, description: tool.description, pluginId, route: tool.route!,
    parameters: tool.parameters ?? { type: 'object', properties: {} },
  })));
  const messages = [{ role: 'user' as const, content: '로그 보여줘' }];
  const defaultTurn = applyDeferredTools(messages, specs, { userText: '로그 보여줘' });
  const nativeAllTurn = applyDeferredTools(messages, specs, { userText: '로그 보여줘', routingStrategy: 'native-all' });
  const releaseOnlyIds = new Set(sources.filter(({ tools }) => tools.some(({ name }) => name === 'ReleaseStatus'))
    .map(({ pluginId }) => pluginId));
  const inactiveWarmPreloads = applyDeferredTools(messages, specs,
    { userText: '로그 보여줘', activePluginIds: releaseOnlyIds }).stats.warmPreloaded;
  const inactiveNativeAllActive = applyDeferredTools(messages, specs,
    { userText: '로그 보여줘', activePluginIds, routingStrategy: 'native-all' }).tools.map(({ name }) => name);
  const inactiveRouteSearchMatches = dispatchToolSearch({ query: 'route:강의 노트 스크랩 앱 배포해줘' },
    { specs, activePluginIds }).matched;
  const inactiveSelectUnknown = dispatchToolSearch({ query: 'select:app_deploy' },
    { specs, activePluginIds }).unknown;
  const activeRouteSearchMatches = dispatchToolSearch({ query: 'route:로그 보여줘' }, { specs, activePluginIds }).matched;
  const activeRouteSelectMatches = dispatchToolSearch({ query: 'select:ObserveLogs' }, { specs, activePluginIds }).matched;
  const disabledTurn = applyDeferredTools(messages, specs, { userText: '로그 보여줘', enabled: false });
  const runtime = {
    defaultActive: defaultTurn.tools.map(({ name }) => name),
    nativeAllActive: nativeAllTurn.tools.map(({ name }) => name),
    defaultDeferred: defaultTurn.stats.deferredNames,
  };
  return { defaultRoute, explicitNativeAll, disabledPlugin, failedIndex, indexLoads, runtime,
    firstPartyPluginIds: pluginIds.sort(), ontologyPluginIds: buildToolRouteIndex(sources).ontology.map(({ pluginId }) => pluginId).sort(),
    appDeployRoute, appDeployBlocked, appDeployHandlerCalls, multiActive, inactiveAppDeploy, multiActiveFallback,
    inactiveRouteSearchMatches, inactiveSelectUnknown, inactiveWarmPreloads, inactiveNativeAllActive,
    providerRouteSchemas: defaultTurn.tools.filter((tool) => tool.pluginId && tool.route).map(({ name }) => name),
    nativeAllProviderRouteSchemas: nativeAllTurn.tools.filter((tool) => tool.pluginId && tool.route).map(({ name }) => name),
    disabledProviderRouteSchemas: disabledTurn.tools.filter((tool) => tool.pluginId && tool.route).map(({ name }) => name),
    activeRouteSearchMatches, activeRouteSelectMatches, graphAllowlist };
}
