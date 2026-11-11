import { expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runToolRouterWorld } from './tool-router-world.js';
import { parsePluginManifest } from '../plugins/core/manifest.js';
import { buildToolRouteIndex, DEFAULT_TOOL_ROUTING_STRATEGY, defaultToolRoutingStrategy, routeToolIntent } from '../tool-router/index.js';
import { buildSessionRuntimeToolSpecs } from '../session-runtime/index.js';
import { applyDeferredTools } from '../session-runtime/tier-flip.js';
import { nativeToolCatalog } from '../native-tool-catalog.js';
import { registerAllDefaultToolRuntimes } from '../tool-runtime/index.js';
import { listToolRuntimes } from '../tool-runtime/registry.js';
import { buildGetDashboardStateTool } from '../skills/tools/dashboard-state.js';
import {
  buildTerminalModalDetachTool,
  buildTerminalModalFocusTool,
  buildTerminalModalKillTool,
  buildTerminalModalListTool,
  buildTerminalModalObserveTool,
} from '../skills/tools/terminal-modal.js';
import { routeToolSearch } from '../skills/tools/tool-search-route.js';
import { takeHydratedTools } from '../skills/tools/tool-search-spec.js';
import { estimateTokens } from '../tokens.js';

test('tool-router-world: index defaults on, explicit native bypass and failure remain enabled scoped', () => {
  const receipt = runToolRouterWorld();
  expect(DEFAULT_TOOL_ROUTING_STRATEGY).toBe('index');
  expect(defaultToolRoutingStrategy('native-all')).toBe('native-all');
  expect(receipt.defaultRoute).toMatchObject({ mode: 'index', miss: false });
  expect(receipt.defaultRoute.matches[0]).toMatchObject({ pluginId: 'elanous-observe', name: 'ObserveLogs' });
  // Source: plugins/absorb/plugin.json declares the built-in absorb route surface now discovered by the router world.
  expect(receipt.explicitNativeAll).toMatchObject({ mode: 'native-all', miss: true, enabledPluginIds: ['absorb', 'elanous-app-deploy', 'elanous-observe', 'elanous-release'] });
  expect(receipt.explicitNativeAll.fallbackReason).toBeUndefined();
  expect(receipt.disabledPlugin).toMatchObject({ mode: 'index', miss: true, matches: [] });
  expect(receipt.failedIndex).toMatchObject({ mode: 'native-all', fallbackReason: 'router-error', enabledPluginIds: ['elanous-release'] });
  expect(receipt.indexLoads).toBe(5); // Source: src/ux-sim/tool-router-world.ts calls loadIndex for default, disabled, deploy, multi-active and inactive routes.
  expect(receipt.runtime.defaultActive).not.toContain('ObserveLogs');
  expect(receipt.runtime.defaultActive).not.toContain('ReleaseGraphStart');
  expect(receipt.runtime.defaultDeferred).toContain('ObserveLogs');
  expect(receipt.runtime.defaultDeferred).toContain('ReleaseGraphStart');
  expect(receipt.runtime.nativeAllActive).not.toContain('ReleaseGraphStart');
  expect(receipt.runtime.nativeAllActive).not.toContain('app_deploy');
  expect(receipt.providerRouteSchemas).toEqual([]);
  expect(receipt.nativeAllProviderRouteSchemas).toEqual([]);
  expect(receipt.disabledProviderRouteSchemas).toEqual([]);
  expect(receipt.activeRouteSearchMatches).toContain('ObserveLogs');
  expect(receipt.activeRouteSelectMatches).toContain('ObserveLogs');
  // Source: plugins/absorb/plugin.json is included in builtin plugin discovery and declares AI tools.
  expect(receipt.firstPartyPluginIds).toEqual(['absorb', 'elanous-app-deploy', 'elanous-observe', 'elanous-release']);
  expect(receipt.ontologyPluginIds).toEqual(receipt.firstPartyPluginIds);
  expect(receipt.appDeployRoute.matches[0]).toMatchObject({ pluginId: 'elanous-app-deploy', name: 'app_deploy', route: { requiresConfirm: true } });
  expect(receipt.appDeployBlocked).toBe(true);
  expect(receipt.appDeployHandlerCalls).toBe(0);
});

test('tool-router-world: multiple active plugins route together and fallback stays active scoped', () => {
  const receipt = runToolRouterWorld();
  expect(new Set(receipt.multiActive.matches.map(({ pluginId }) => pluginId))).toEqual(new Set(['elanous-release', 'elanous-observe']));
  expect(receipt.inactiveAppDeploy).toMatchObject({ mode: 'index', miss: true, matches: [] });
  expect(receipt.multiActiveFallback).toMatchObject({ mode: 'native-all', fallbackReason: 'router-error',
    enabledPluginIds: ['elanous-observe', 'elanous-release'] });
  expect(receipt.inactiveRouteSearchMatches).toEqual([]);
  expect(receipt.inactiveSelectUnknown).toEqual(['app_deploy']);
  expect(receipt.inactiveWarmPreloads).toBe(0);
  expect(receipt.inactiveNativeAllActive).not.toContain('app_deploy');
});

test('tool-router-world: an app mention alone does not trigger a deploy route', () => {
  const route = {
    triggers: ['deploy app'], examples: [], sideEffects: 'external' as const,
    risk: 'high' as const, cost: 'spends-cloud' as const, requiresConfirm: true,
  };
  const index = buildToolRouteIndex([{ pluginId: 'fixture-deploy', tools: [{ name: 'Deploy', description: 'Deploy', route }] }]);
  const enabledPluginIds = new Set(['fixture-deploy']);
  expect(routeToolIntent(index, 'app', { enabledPluginIds }).miss).toBe(true);
  expect(routeToolIntent(index, 'deploy app', { enabledPluginIds }).matches[0]?.name).toBe('Deploy');
});

test('tool-router-world: multiword ontology does not send budget or dashboard status to observe', () => {
  const sources = readdirSync(join(process.cwd(), 'plugins')).sort().flatMap((name) => {
    const manifestPath = join(process.cwd(), 'plugins', name, 'plugin.json');
    if (!existsSync(manifestPath)) return [];
    const manifest = parsePluginManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
    const tools = (manifest.contributes.aiTools ?? []).filter((tool) => tool.route);
    return tools.length > 0 ? [{ pluginId: manifest.id, tools }] : [];
  });
  const statusRoute = (trigger: string) => ({
    triggers: [trigger], examples: [], sideEffects: 'read-only' as const,
    risk: 'low' as const, cost: 'cheap' as const, requiresConfirm: false,
  });
  sources.push(
    { pluginId: 'elanous-guardian', tools: [{ name: 'BudgetStatus', description: 'Read budget status.', route: statusRoute('예산 상태') }] },
    { pluginId: 'elanous-nexus-apps', tools: [{ name: 'GetDashboardState', description: 'Read dashboard state.', route: statusRoute('대시보드 상태') }] },
  );
  const index = buildToolRouteIndex(sources);
  const enabledPluginIds = new Set(sources.map(({ pluginId }) => pluginId));

  expect(routeToolIntent(index, '상태', { enabledPluginIds }).miss).toBe(true);
  expect(routeToolIntent(index, '운영 상태', { enabledPluginIds }).matches[0]?.name).toBe('ObserveOpsStatus');
  expect(routeToolIntent(index, '발행 상태', { enabledPluginIds }).matches[0]?.name).toBe('ReleaseStatus');
  expect(routeToolIntent(index, '예산 상태', { enabledPluginIds }).matches[0]?.name).toBe('BudgetStatus');
  expect(routeToolIntent(index, '대시보드 상태', { enabledPluginIds }).matches[0]?.name).toBe('GetDashboardState');
  expect(routeToolIntent(index, 'x ops x status', { enabledPluginIds }).matches.map(({ name }) => name)).not.toContain('ObserveOpsStatus');
  expect(routeToolIntent(index, 'ops x ops status', { enabledPluginIds }).matches[0]?.name).toBe('ObserveOpsStatus');
});

test('tool-router-world: graph handlers require declared IDs and confirmation before execution', () => {
  const receipt = runToolRouterWorld();
  expect(receipt.graphAllowlist).toEqual({
    handler: 'graph:declared',
    denied: 'graph-not-allowlisted', missing: 'graph-not-allowlisted', malformed: 'graph-not-allowlisted',
    unconfirmed: 'confirmation-required', allowed: 'dispatched', dotted: 'dispatched', calls: 2,
  });
});

test('tool-router-world: graph route index requires a matching declared graph ID', () => {
  const route = {
    triggers: ['run graph'], examples: [], sideEffects: 'external' as const,
    risk: 'high' as const, cost: 'spawns-run' as const, requiresConfirm: true,
  };
  const pluginId = 'fixture-graph-routes';
  const allowedGraphIds = new Set(['declared', 'other']);
  const index = buildToolRouteIndex([{ pluginId, tools: [
    { name: 'RunDeclaredGraph', description: 'Run declared graph', handler: 'graph:declared', route },
    { name: 'RunOtherGraph', description: 'Run another graph', handler: './graph:other', route },
    { name: 'RunUnlistedGraph', description: 'Run unlisted graph', handler: 'graph:unlisted', route },
    { name: 'RunMalformedGraph', description: 'Run malformed graph', handler: 'graph:../secret', route },
  ] }], { allowedGraphIdsByPlugin: new Map([[pluginId, allowedGraphIds]]) });
  const enabledPluginIds = new Set([pluginId]);
  const routeNames = (allowedGraphIds?: ReadonlySet<string>) => routeToolIntent(index, 'run graph', {
    enabledPluginIds, ...(allowedGraphIds ? { allowedGraphIds } : {}),
  }).matches.map(({ name }) => name);

  expect(routeNames()).toEqual([]);
  expect(routeNames(new Set(['declared']))).toEqual(['RunDeclaredGraph']);
  expect(routeNames(new Set(['other']))).toEqual(['RunOtherGraph']);
  expect(routeNames(new Set(['../secret']))).toEqual([]);
  expect(index.entries.map(({ name }) => name)).toEqual(['RunDeclaredGraph', 'RunOtherGraph']);
});

test('tool-router-world: separate tool sources keep trigger eligibility per tool', () => {
  const route = (trigger: string) => ({
    triggers: [trigger], examples: [], sideEffects: 'read-only' as const,
    risk: 'low' as const, cost: 'cheap' as const, requiresConfirm: false,
  });
  const sources = [
    { pluginId: 'fixture-plugin', tools: [{ name: 'First', description: 'first', route: route('alpha') }] },
    { pluginId: 'fixture-plugin', tools: [{ name: 'Second', description: 'second', route: route('beta') }] },
  ];
  const index = buildToolRouteIndex(sources);
  expect(index.ontology.filter(({ pluginId }) => pluginId === 'fixture-plugin')).toEqual([
    { pluginId: 'fixture-plugin', terms: [] },
  ]);
  expect(routeToolIntent(index, 'beta', { enabledPluginIds: new Set(['fixture-plugin']) }).matches.map(({ name }) => name)).toEqual(['Second']);
});


const LOW_RISK_TOOL_CORPUS = [
  { prompt: 'Show the current dashboard state.', expected: 'GetDashboardState', searchName: 'GetDashboardState' },
  { prompt: 'List active terminal modal sessions.', expected: 'TerminalModalList', searchName: 'TerminalModalList' },
  { prompt: 'Capture the current terminal modal screen.', expected: 'TerminalModalObserve', searchName: 'TerminalModalObserve' },
  { prompt: 'Create a Linear issue in team OPS with a short title.', expected: 'elanous_linear_issue', searchName: 'ElanousLinearIssue' },
] as const;

test('tool-router-world: low-risk dashboard, modal-read, and Linear schemas hydrate through ToolSearch', () => {
  registerAllDefaultToolRuntimes();
  const optionalTools = [
    buildGetDashboardStateTool(),
    buildTerminalModalListTool(),
    buildTerminalModalObserveTool(),
    buildTerminalModalFocusTool(),
    buildTerminalModalDetachTool(),
    buildTerminalModalKillTool(),
  ];
  const toolAvailability = {
    GetDashboardState: true,
    TerminalModalList: true,
    TerminalModalObserve: true,
    TerminalModalFocus: true,
    TerminalModalDetach: true,
    TerminalModalKill: true,
    elanous_linear_issue: true,
  };
  const targetNames = new Set<string>(LOW_RISK_TOOL_CORPUS.map(({ expected }) => expected));
  const directCatalog = nativeToolCatalog.map((entry) => (targetNames.has(entry.displayName) || targetNames.has(entry.id)
      || entry.aliases.some((alias) => targetNames.has(alias)))
    ? { ...entry, alwaysLoad: true, shouldDefer: false, warmPreload: true }
    : entry);

  let directSchemaTokens = 0;
  let indexedRoutingTokens = 0;
  for (const item of LOW_RISK_TOOL_CORPUS) {
    const specs = buildSessionRuntimeToolSpecs({
      userText: item.prompt,
      hostTools: [],
      runtimeTools: listToolRuntimes('tui'),
      optionalTools,
      toolAvailability,
    });
    const messages = [{ role: 'user' as const, content: item.prompt }];
    const direct = applyDeferredTools(messages, specs, { userText: item.prompt, catalog: directCatalog });
    const directNames = direct.tools.map(({ name }) => name);
    const availableTargets = LOW_RISK_TOOL_CORPUS.filter((target) => specs.some(({ name }) => name === target.expected));
    for (const target of availableTargets) expect(directNames).toContain(target.expected);
    directSchemaTokens += estimateTokens(JSON.stringify(direct.tools)) + estimateTokens(JSON.stringify(direct.messages));

    const indexed = applyDeferredTools(messages, specs, { userText: item.prompt });
    const indexedNames = indexed.tools.map(({ name }) => name);
    for (const target of availableTargets) expect(indexedNames).not.toContain(target.expected);
    expect(indexedNames).toContain('ToolSearch');
    expect(indexed.stats.deferredNames).toContain(item.searchName);
    indexedRoutingTokens += estimateTokens(JSON.stringify(indexed.tools)) + estimateTokens(JSON.stringify(indexed.messages));

    const hydrated = routeToolSearch({ query: `select:${item.expected}` }, specs, { surface: 'ux-sim' });
    expect((hydrated as { matched: string[] }).matched).toEqual([item.searchName]);
    expect(takeHydratedTools(hydrated).map(({ name }) => name)).toEqual([item.expected]);
  }
  console.log(`[low-risk-toolsearch-measure] prompts=${LOW_RISK_TOOL_CORPUS.length} native-full-payload-tokens/turn=${(directSchemaTokens / LOW_RISK_TOOL_CORPUS.length).toFixed(1)} index-full-payload-tokens/turn=${(indexedRoutingTokens / LOW_RISK_TOOL_CORPUS.length).toFixed(1)}`);

  const nonTargetSpecs = buildSessionRuntimeToolSpecs({
    userText: 'Show the current dashboard state.', hostTools: [],
    runtimeTools: listToolRuntimes('tui'), optionalTools, toolAvailability,
  });
  const indexed = applyDeferredTools([{ role: 'user', content: 'Show the current dashboard state.' }], nonTargetSpecs, {
    userText: 'Show the current dashboard state.',
  });
  expect(indexed.tools.map(({ name }) => name)).toEqual(expect.arrayContaining([
    'TerminalModalFocus', 'TerminalModalDetach', 'TerminalModalKill',
  ]));
});
