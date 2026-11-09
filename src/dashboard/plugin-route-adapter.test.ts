import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { createDashboardPluginRouteAdapter } from './plugin-route-adapter.js';
import { buildSessionRuntimeToolSpecs } from '../session-runtime/index.js';
import { applyDeferredTools } from '../session-runtime/tier-flip.js';

function adapter(calls: Array<{ name: string; args: Record<string, unknown> }> = []) {
  return createDashboardPluginRouteAdapter({
    pluginRoot: join(import.meta.dir, '..', '..', 'plugins'),
    dispatchCore: async (name, args) => { calls.push({ name, args }); return { tool: name, args }; },
  });
}

test('classic and ACP-next adapters expose the same plugin route specs with identity metadata', () => {
  const routeAdapter = adapter();
  const classic = routeAdapter.classicHostTools([]);
  const next = routeAdapter.nextHostTools([]);

  expect(classic).toEqual(next);
  expect(classic.map(({ name }) => name)).toEqual(['ObserveLogs', 'ObserveOpsStatus', 'ReleaseStatus', 'ReleaseGraphStart', 'app_deploy']);
  expect(classic.find(({ name }) => name === 'ObserveLogs')).toMatchObject({
    pluginId: 'elanous-observe', route: { sideEffects: 'read-only', requiresConfirm: false },
  });
  expect(classic.find(({ name }) => name === 'ReleaseGraphStart')).toMatchObject({
    pluginId: 'elanous-release', route: { sideEffects: 'irreversible', risk: 'high', requiresConfirm: true },
  });
  expect(classic.find(({ name }) => name === 'app_deploy')).toMatchObject({
    pluginId: 'elanous-app-deploy', route: { sideEffects: 'external', risk: 'high', requiresConfirm: true },
  });
});

test('classic and ACP-next TUI catalogs preload the matching release and observe routes', () => {
  const routeAdapter = adapter();
  const adapters = [
    ['classic', routeAdapter.classicHostTools],
    ['ACP-next', routeAdapter.nextHostTools],
  ] as const;

  for (const [, adaptHostTools] of adapters) {
    for (const [query, expected] of [
      ['발행 어디까지?', 'ReleaseStatus'],
      ['로그 보여줘', 'ObserveLogs'],
    ]) {
      const specs = buildSessionRuntimeToolSpecs({ userText: query, hostTools: adaptHostTools([]) });
      const turn = applyDeferredTools([{ role: 'user', content: query }], specs, { userText: query });
      expect(turn.tools.map((tool) => tool.name)).toContain(expected);
    }
  }
});

test('route-only native handlers reach existing core tools and preserve their arguments', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const routeAdapter = adapter(calls);
  for (const [routeName, coreName] of [
    ['ObserveLogs', 'logs_query'],
    ['ObserveOpsStatus', 'ops_status'],
    ['ReleaseStatus', 'release_status'],
  ]) {
    const args = { request: routeName };
    await expect(routeAdapter.dispatch(routeName, args)).resolves.toEqual({
      ok: true,
      result: { tool: coreName, args },
    });
  }
  expect(calls.map(({ name }) => name)).toEqual(['logs_query', 'ops_status', 'release_status']);
});

test('a colliding host tool wins in both catalog exposure and dispatch', async () => {
  const calls: string[] = [];
  const routeAdapter = adapter();
  const hostTool = {
    name: 'ObserveLogs', description: 'host-owned route name', parameters: {},
    handler: async () => { calls.push('host'); return 'host result'; },
  };

  expect(routeAdapter.classicHostTools([hostTool]).filter(({ name }) => name === 'ObserveLogs')).toEqual([hostTool]);
  await expect(routeAdapter.dispatch('ObserveLogs', {})).resolves.toBeNull();
  expect(calls).toEqual([]);
});

test('ReleaseGraphStart stays disabled even when a caller marks the request confirmed', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const routeAdapter = adapter(calls);

  await expect(routeAdapter.dispatch('ReleaseGraphStart', {}, true)).resolves.toMatchObject({ ok: false });
  expect(calls).toEqual([]);
});

test('route dispatch returns null for names outside the native route catalog', async () => {
  await expect(adapter().dispatch('NoSuchPluginTool', {})).resolves.toBeNull();
});
