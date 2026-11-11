import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { LLMToolSpec } from '../llm/tool-spec.js';
import type { NativeToolCatalogEntry } from '../native-tool-catalog.js';
import { parsePluginManifest } from '../plugins/core/manifest.js';
import { PluginHost, type HostHooks } from '../plugins/core/host.js';
import { applyDeferredTools } from '../session-runtime/tier-flip.js';
import { routeToolSearch } from '../skills/tools/tool-search-route.js';
import { debug } from '../debug/log.js';
import { takeHydratedTools } from '../skills/tools/tool-search-spec.js';
import { dispatchToolSearch } from '../skills/tools/tool-search.js';
import { toLLMToolSpec } from '../llm/tool-spec.js';
import { runPluginReleaseObserveRouteSimulation } from './plugin-release-observe-route-world.js';
import { buildToolRouteIndex, routeToolIntent } from '../tool-router/index.js';

const routeHostHooks: HostHooks = { log: () => {}, hudSet: () => {}, requestRender: () => {}, focusPane: () => {} };

async function createHostedRouteSpecs(pluginIds: string[]): Promise<LLMToolSpec[]> {
  const root = mkdtempSync(join(tmpdir(), 'ux-sim-plugin-route-host-'));
  const specs: LLMToolSpec[] = [];
  try {
    for (const pluginId of pluginIds) {
      const manifestPath = join(process.cwd(), 'plugins', pluginId, 'plugin.json');
      const manifest = parsePluginManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
      const routeTools = (manifest.contributes.aiTools ?? []).filter((tool) => tool.route);
      const userDir = join(root, pluginId);
      const pluginDir = join(userDir, pluginId);
      mkdirSync(pluginDir, { recursive: true });
      writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify({
        id: manifest.id, name: manifest.name, version: manifest.version, main: './plugin.ts',
        contributes: { aiTools: routeTools },
      }));
      const runtimeTools = routeTools.map((tool) => ({
        name: tool.name, description: tool.description, parameters: tool.parameters ?? { type: 'object', properties: {} },
      }));
      writeFileSync(join(pluginDir, 'plugin.ts'), `export default {
        name: ${JSON.stringify(manifest.name)}, version: ${JSON.stringify(manifest.version)}, description: '',
        initialState: () => ({}), panes: {},
        llmTools: ${JSON.stringify(runtimeTools)}.map((tool) => ({ ...tool, handler: async () => ({ ok: true }) })),
      };`);
      const host = new PluginHost(routeHostHooks, null, { userDir });
      await host.discover();
      await host.activate(manifest.id);
      specs.push(...host.activePluginLLMTools().map(toLLMToolSpec));
      await host.deactivate();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  return specs;
}

test('release and observe manifest routes resolve deterministically with safe misses and fallback', () => {
  const result = runPluginReleaseObserveRouteSimulation();

  expect(result.ok).toBe(true);
  expect(result.scenarios.primaryRoutes.releaseStatus.matches[0]).toMatchObject({
    pluginId: 'elanous-release', name: 'ReleaseStatus', route: { sideEffects: 'read-only', requiresConfirm: false },
  });
  expect(result.scenarios.primaryRoutes.observeLogs.matches[0]).toMatchObject({
    pluginId: 'elanous-observe', name: 'ObserveLogs', route: { sideEffects: 'read-only', requiresConfirm: false },
  });
  expect(result.scenarios.releaseStart.matches[0]).toMatchObject({
    pluginId: 'elanous-release', name: 'ReleaseGraphStart', route: { sideEffects: 'irreversible', risk: 'high', requiresConfirm: true },
  });
  expect(result.scenarios.releaseStart).toMatchObject({
    confirmationRequired: true,
    blockedBeforeConfirmation: true,
    handlerCallsBeforeConfirmation: 0,
    handlerCallsAfterConfirmation: 1,
    dispatchedAfterConfirmation: true,
  });
  expect(result.scenarios.ordinaryHelp).toMatchObject({ query: 'show me how to bake a cake', mode: 'index', miss: true, matches: [] });
  expect(result.scenarios.disabledObservePlugin).toMatchObject({ mode: 'index', miss: true, matches: [] });
  expect(result.scenarios.routerFailure).toMatchObject({
    mode: 'native-all', fallbackReason: 'router-error', miss: true, enabledPluginIds: ['elanous-release'],
  });
});


test('plugin route schemas stay deferred and ToolSearch resolves a Korean ask to the English schema', async () => {
  const specs = await createHostedRouteSpecs(['elanous-release', 'elanous-observe']);
  const catalog = specs.map((tool) => ({
    id: tool.name.toLowerCase(), kind: 'other' as const, aliases: [], displayName: tool.name,
    description: tool.description, promptSummary: tool.description, host: ['skill'] as ['skill'],
    safety: ['read-only'] as ['read-only'], supportsParallel: true, defaultEnabled: true,
    alwaysLoad: false, shouldDefer: true,
  } as NativeToolCatalogEntry));
  const query = '0.3.8 발행 준비 어디까지 됐어?';
  const turn = applyDeferredTools([{ role: 'user', content: query }], specs, { userText: query, catalog });
  expect(turn.tools.map((tool) => tool.name)).toContain('ToolSearch');
  expect(turn.tools.map((tool) => tool.name)).not.toContain('ReleaseStatus');
  expect(turn.stats.deferredNames).toContain('ReleaseStatus');
  expect(turn.stats.deferredNames).toContain('ObserveLogs');

  const highRiskTurn = applyDeferredTools(
    [{ role: 'user', content: '발행 시작해' }], specs, { userText: '발행 시작해', catalog },
  );
  expect(highRiskTurn.tools.map((tool) => tool.name)).not.toContain('ReleaseGraphStart');
  expect(highRiskTurn.stats.deferredNames).toContain('ReleaseGraphStart');

  // Exercise the installed native catalog as well as the injected fixture above:
  // unclassified route tools still defer by manifest policy.
  const defaultCatalogSafeTurn = applyDeferredTools(
    [{ role: 'user', content: query }], specs, { userText: query },
  );
  expect(defaultCatalogSafeTurn.tools.map((tool) => tool.name)).toContain('ToolSearch');
  expect(defaultCatalogSafeTurn.tools.map((tool) => tool.name)).not.toContain('ReleaseStatus');
  expect(defaultCatalogSafeTurn.stats.deferredNames).toContain('ReleaseStatus');
  expect(defaultCatalogSafeTurn.tools.map((tool) => tool.name)).not.toContain('ReleaseGraphStart');

  const defaultCatalogTurn = applyDeferredTools(
    [{ role: 'user', content: '발행 시작해' }], specs, { userText: '발행 시작해' },
  );
  expect(defaultCatalogTurn.tools.map((tool) => tool.name)).not.toContain('ReleaseGraphStart');
  expect(defaultCatalogTurn.stats.deferredNames).toContain('ReleaseGraphStart');

  const unsearchableCatalog = catalog.map((entry) => ({
    ...entry,
    ...(entry.displayName === 'ReleaseGraphStart' ? { toolSearchable: false } : {}),
  }));
  const hiddenHighRiskTurn = applyDeferredTools(
    [{ role: 'user', content: '발행 시작해' }], specs,
    { userText: '발행 시작해', catalog: unsearchableCatalog },
  );
  expect(hiddenHighRiskTurn.tools.map((tool) => tool.name)).not.toContain('ReleaseGraphStart');
  expect(hiddenHighRiskTurn.stats.deferredNames).toContain('ReleaseGraphStart');
  const hiddenRouteResult = routeToolSearch({ query: 'route:발행 시작해' }, specs, { surface: 'ux-sim' });
  expect(takeHydratedTools(hiddenRouteResult).map((tool) => tool.name)).toContain('ReleaseGraphStart');

  const originalDebugStatus = debug.status();
  const priorEventCount = debug.events(1000).length;
  debug.enable();
  debug.setVerboseEnabled(true);
  try {
    applyDeferredTools([{ role: 'user', content: query }], specs, { userText: query, catalog });
    const cold = routeToolSearch({ query: `route:${query}` }, specs, { surface: 'ux-sim' }) as { matched: string[] };
    const direct = dispatchToolSearch({ query: `route:${query}` }, { specs, surface: 'ux-sim' });
    expect(cold.matched).toEqual(['ReleaseStatus']);
    expect(direct.matched).toEqual(cold.matched);
    const hydrated = takeHydratedTools(cold);
    expect(takeHydratedTools(direct)).toMatchObject(hydrated);
    expect(hydrated).toHaveLength(1);
    expect(hydrated[0]).toMatchObject({ name: 'ReleaseStatus', pluginId: 'elanous-release', parameters: { type: 'object' } });
    const routeEvents = debug.events(1000).slice(priorEventCount);
    expect(routeEvents.some((event) => event.category === 'tool.route' && event.event === 'route-decision'
      && (event.data as { source?: string })?.source === 'turn-preload')).toBe(false);
    expect(routeEvents.some((event) => event.category === 'tool.route' && event.event === 'route-decision'
      && (event.data as { surface?: string; matches?: { name: string; pluginId: string }[] })?.surface === 'ux-sim'
      && (event.data as { matches?: { name: string; pluginId: string }[] })?.matches?.[0]?.name === 'ReleaseStatus'
      && (event.data as { matches?: { name: string; pluginId: string }[] })?.matches?.[0]?.pluginId === 'elanous-release')).toBe(true);
  } finally {
    debug.setMirror(originalDebugStatus.mirror);
    debug.setVerboseEnabled(originalDebugStatus.verbose);
    debug.setDiagEnabled(originalDebugStatus.diag);
    debug.setRenderSuppressed(originalDebugStatus.renderSuppressed);
  }
  const restoredDebugStatus = debug.status();
  expect(restoredDebugStatus.mirror).toBe(originalDebugStatus.mirror);
  expect(restoredDebugStatus.verbose).toBe(originalDebugStatus.verbose);
  expect(restoredDebugStatus.diag).toBe(originalDebugStatus.diag);
  expect(restoredDebugStatus.renderSuppressed).toBe(originalDebugStatus.renderSuppressed);
});


test('RRF keeps duplicate tool names isolated by plugin and gives equal ontology ranks a tie', () => {
  const route = {
    triggers: ['alpha'], examples: ['alpha request'], sideEffects: 'read-only' as const,
    risk: 'low' as const, cost: 'cheap' as const, requiresConfirm: false,
  };
  const index = buildToolRouteIndex([
    { pluginId: 'plugin-a', tools: [{ name: 'SharedTool', description: 'alpha same', route }] },
    { pluginId: 'plugin-b', tools: [{ name: 'SharedTool', description: 'beta same', route }] },
  ], [
    { pluginId: 'plugin-a', terms: ['same'] },
    { pluginId: 'plugin-b', terms: ['same'] },
  ]);
  const result = routeToolIntent(index, 'alpha same', { enabledPluginIds: new Set(['plugin-a', 'plugin-b']) });
  expect(result.matches.map((match) => match.pluginId)).toEqual(['plugin-a', 'plugin-b']);
  expect(result.matches[0]?.ontology).toBe(result.matches[1]?.ontology);
  const surfaceSpecs: LLMToolSpec[] = [
    { name: 'SharedTool', description: 'alpha same', parameters: { type: 'object', properties: { owner: { const: 'plugin-a' } } }, pluginId: 'plugin-a', route },
    { name: 'SharedTool', description: 'beta same', parameters: { type: 'object', properties: { owner: { const: 'plugin-b' } } }, pluginId: 'plugin-b', route },
  ];
  const toolSearch = routeToolSearch({ query: 'route:alpha same' }, surfaceSpecs, { surface: 'ux-sim' });
  expect(takeHydratedTools(toolSearch)).toMatchObject([
    { name: 'SharedTool', pluginId: 'plugin-a', parameters: { properties: { owner: { const: 'plugin-a' } } } },
  ]);
});


test('plugin routes stay out of provider schemas and remain searchable when native names overlap', () => {
  const routeSpec: LLMToolSpec = {
    name: 'SharedLookup', description: 'release status', parameters: { type: 'object', properties: { source: { const: 'plugin-route' } } },
    pluginId: 'elanous-release', route: {
      triggers: ['발행'], examples: ['발행 확인'], sideEffects: 'read-only', risk: 'low', cost: 'cheap', requiresConfirm: false,
    },
  };
  const nativeSpec: LLMToolSpec = {
    name: 'SharedLookup', description: 'unrelated native tool', parameters: { type: 'object', properties: { source: { const: 'native' } } },
  };
  const catalog = [{
    id: 'sharedlookup', kind: 'other' as const, aliases: [], displayName: 'SharedLookup', description: '', promptSummary: '',
    host: ['skill'] as ['skill'], safety: ['read-only'] as ['read-only'], supportsParallel: true, defaultEnabled: true,
    alwaysLoad: false, shouldDefer: true,
  } as NativeToolCatalogEntry];
  const hostedRouteDefinition = { ...routeSpec, handler: async () => undefined };
  const convertedRoute = toLLMToolSpec(hostedRouteDefinition);
  expect(convertedRoute).toMatchObject({ pluginId: 'elanous-release', route: routeSpec.route });
  const result = applyDeferredTools([{ role: 'user', content: '발행 확인' }], [convertedRoute, nativeSpec], {
    userText: '발행 확인', catalog,
  });
  expect(result.tools.filter((tool) => tool.pluginId && tool.route)).toEqual([]);
  expect(result.stats.warmPreloaded).toBe(0);
  expect(result.stats.deferredNames).toContain('SharedLookup');
  expect(dispatchToolSearch({ query: 'route:발행 확인' }, { specs: [convertedRoute], activePluginIds: new Set(['elanous-release']) }).matched)
    .toContain('SharedLookup');

  const dynamicallyDeferredRoute = {
    ...routeSpec, name: 'DynamicLookup', alwaysLoad: false, shouldDefer: true,
  } as LLMToolSpec & { alwaysLoad: false; shouldDefer: true };
  const dynamicResult = applyDeferredTools([{ role: 'user', content: '발행 확인' }], [dynamicallyDeferredRoute], {
    userText: '발행 확인', catalog: [],
  });
  expect(dynamicResult.tools.map((tool) => tool.name)).not.toContain('DynamicLookup');
  expect(dynamicResult.stats.deferredNames).toContain('DynamicLookup');
  expect(dynamicResult.stats.warmPreloaded).toBe(0);
});
