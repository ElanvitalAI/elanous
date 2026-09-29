// ── Presentation P5c-a · dashboard-wire integration ──
//
// Exercises the end-to-end chain the dashboard installs at boot:
//
//   loadScenarioCatalog(scenarios/)
//     → registerScenarioRuntimes({getCatalog, onMount})
//       → dispatchToolByName('RunScenario', {id})
//         → onMount(widgets) spawns into widgetHost-shaped stub
//
// The dashboard wire lives inside `showDashboard()` in src/dashboard.ts
// and is not directly unit-testable (~16k LOC entry point). This test
// reproduces the same wiring the dashboard does and proves that the
// four tools round-trip a real YAML scenario through the shared
// ToolRuntime registry.

import { describe, test, expect, beforeEach } from 'bun:test';
import { join } from 'path';
import { loadScenarioCatalog } from '../../src/scenarios/catalog.js';
import type { ScenarioCatalog, ScenarioDef } from '../../src/scenarios/types.js';
import type { DeclarativeWidgetNode } from '../../src/ui/declarative/index.js';
import {
  registerScenarioRuntimes,
  __resetScenarioRuntimesForTest,
} from '../../src/tool-runtime/scenario-runtimes.js';
import { createLayout } from '../../src/layout/host.js';
import { mountScenarioIntoTarget } from '../../src/tool-runtime/scenario-target-mount.js';
import {
  dispatchToolByName,
  _resetToolRuntimeRegistryForTest,
} from '../../src/tool-runtime/registry.js';

const SCENARIOS_DIR = join(__dirname, '..', '..', 'scenarios');
const CTX = { surface: 'dashboard' as const };

const MODAL_SINGLE_DEF: ScenarioDef = {
  id: 'modal-single',
  title: 'Modal Single',
  layout: { widget: 'markdown', config: { text: 'hello modal' } },
};

interface SpawnCall {
  type: string;
  id?: string;
  config?: Record<string, unknown>;
}

function createWidgetHostStub(): {
  calls: SpawnCall[];
  spawn: (opts: { type: string; id?: string; config?: Record<string, unknown> }) => { id: string };
} {
  const calls: SpawnCall[] = [];
  return {
    calls,
    spawn(opts) {
      calls.push({ ...opts });
      return { id: opts.id ?? `spawned:${calls.length}` };
    },
  };
}

function wireDashboardBoot(
  catalog: ScenarioCatalog | undefined,
  host: ReturnType<typeof createWidgetHostStub>,
): void {
  let dashboardModals = [{ id: 'dashboard-pane-modal', widgetInstanceId: 'old-modal-widget', position: 'center' as const }];
  let pluginLayout = createLayout(
    [{ height: 'flex', cells: [{ widgetInstanceId: null, width: 'flex' }] }],
    [{ id: 'plugin-modal', widgetInstanceId: 'old-plugin-modal-widget', position: 'center' as const }],
  );
  registerScenarioRuntimes({
    getCatalog: () => catalog,
    onMount: (widgets: readonly DeclarativeWidgetNode[], target) => {
      if (target) {
        return mountScenarioIntoTarget(widgets, target, {
          spawnWidget: (spec) => {
            const id = spec.id ?? `target-mounted:${host.calls.length + 1}`;
            host.spawn({ type: spec.type, ...(spec.config ? { config: spec.config } : {}), id });
            return { id };
          },
          disposeWidget: () => {},
          getDashboardModals: () => dashboardModals,
          setDashboardModals: (modals) => { dashboardModals = [...modals]; },
          getPluginLayout: () => pluginLayout,
          setPluginLayout: (layout) => { pluginLayout = layout; },
          getDashboardManagedWidgetIds: () => ['wd-log', 'wd-browser'],
        });
      }
      for (const w of widgets) {
        try {
          host.spawn({
            type: w.type,
            ...(w.id !== undefined ? { id: w.id } : {}),
            ...(w.config !== undefined
              ? { config: w.config as Record<string, unknown> }
              : {}),
          });
        } catch { /* mirrors dashboard.ts · per-widget failure swallowed */ }
      }
      return { mounted: true };
    },
  });
}

beforeEach(() => {
  _resetToolRuntimeRegistryForTest();
  __resetScenarioRuntimesForTest();
});

describe('P5c-a · dashboard wire', () => {
  test('all four scenario tools resolve via dispatchToolByName after boot', async () => {
    const catalog = await loadScenarioCatalog(SCENARIOS_DIR);
    const host = createWidgetHostStub();
    wireDashboardBoot(catalog, host);

    // Canonical ids · registry direct-hit. PascalCase alias dispatch
    // (e.g. `RunScenario`) requires an entry in native-tool-catalog
    // which P5c-a keeps out of scope (follow-up).
    for (const id of [
      'ui_list_scenarios',
      'ui_run_scenario',
      'ui_get_scenario_schema',
      'ui_validate_scenario_yaml',
    ]) {
      const args = id === 'ui_validate_scenario_yaml'
        ? { yaml: 'id: x\ntitle: y\nlayout: []\n' }
        : id === 'ui_list_scenarios'
          ? {}
          : { id: '__ping__' };
      const res = await dispatchToolByName(id, args, CTX);
      expect((res as { output: string }).output).toBeDefined();
    }
  });

  test('ListScenarios enumerates the checked-in catalog', async () => {
    const catalog = await loadScenarioCatalog(SCENARIOS_DIR);
    const host = createWidgetHostStub();
    wireDashboardBoot(catalog, host);

    const res = await dispatchToolByName('ui_list_scenarios', {}, CTX);
    const payload = JSON.parse((res as { output: string }).output);
    const ids = payload.scenarios.map((s: { id: string }) => s.id);
    expect(ids).toContain('dashboard-default');
    expect(ids).toContain('heap-graph');
    expect(ids).toContain('iul-timeline-viewer');
  });

  test('RunScenario mounts each top-level widget via the wired onMount', async () => {
    const catalog = await loadScenarioCatalog(SCENARIOS_DIR);
    const host = createWidgetHostStub();
    wireDashboardBoot(catalog, host);

    const res = await dispatchToolByName('ui_run_scenario', { id: 'dashboard-default' }, CTX);
    const payload = JSON.parse((res as { output: string }).output);
    expect(payload.ok).toBe(true);
    expect(payload.mounted).toBe(true);

    // dashboard-default is `log` + `list` at the top level.
    expect(host.calls).toHaveLength(2);
    const spawnedTypes = host.calls.map((c) => c.type).sort();
    expect(spawnedTypes).toEqual(['list', 'log']);
  });

  test('RunScenario refuses window and pane targets without mounting widgets', async () => {
    const catalog = await loadScenarioCatalog(SCENARIOS_DIR);
    const host = createWidgetHostStub();
    wireDashboardBoot(catalog, host);

    for (const target of [
      { kind: 'window', windowId: 1 },
      { kind: 'pane', ref: { windowId: '1', paneId: 'pane-1' } },
    ]) {
      const res = await dispatchToolByName('ui_run_scenario', { id: 'dashboard-default', target }, CTX);
      const payload = JSON.parse((res as { output: string }).output);
      expect(payload.ok).toBe(false);
      expect(payload.mounted).toBe(false);
      expect(payload.target).toEqual(target);
      expect(payload.error).toBe(`RunScenario: target kind "${target.kind}" is not a scenario mount destination`);
    }
    for (const target of [
      { kind: 'window', windowId: '1' },
      { kind: 'pane', ref: { windowId: 1, paneId: 'pane-1' } },
    ]) {
      const res = await dispatchToolByName('ui_run_scenario', { id: 'dashboard-default', target }, CTX);
      const payload = JSON.parse((res as { output: string }).output);
      expect(payload.ok).toBe(false);
      expect(payload.error).toBe('RunScenario: malformed `target` SurfaceAddress');
    }
    expect(host.calls).toHaveLength(0);
  });

  test('RunScenario with unsupported widget target shape still returns an explicit target-mount error', async () => {
    const catalog = await loadScenarioCatalog(SCENARIOS_DIR);
    const host = createWidgetHostStub();
    wireDashboardBoot(catalog, host);

    const res = await dispatchToolByName(
      'ui_run_scenario',
      { id: 'dashboard-default', target: { kind: 'widget', widgetId: 'wd-log' } },
      CTX,
    );
    const payload = JSON.parse((res as { output: string }).output);
    expect(payload.ok).toBe(false);
    expect(payload.mounted).toBe(false);
    expect(payload.error).toMatch(/target widget mount currently supports exactly one top-level widget/);
    expect(payload.target).toEqual({ kind: 'widget', widgetId: 'wd-log' });
    expect(host.calls).toHaveLength(0);
  });

  test('RunScenario with target modal replaces the addressed modal widget for single-widget scenarios', async () => {
    const loaded = await loadScenarioCatalog(SCENARIOS_DIR);
    const catalog: ScenarioCatalog = {
      scenarios: new Map(loaded.scenarios),
      errors: loaded.errors,
    };
    catalog.scenarios.set(MODAL_SINGLE_DEF.id, MODAL_SINGLE_DEF);
    const host = createWidgetHostStub();
    wireDashboardBoot(catalog, host);

    const res = await dispatchToolByName(
      'ui_run_scenario',
      { id: 'heap-graph', target: { kind: 'modal', modalId: 'dashboard-pane-modal' } },
      CTX,
    );
    const payload = JSON.parse((res as { output: string }).output);
    expect(payload.ok).toBe(false);
    expect(payload.error).toMatch(/exactly one top-level widget/);

    const single = await dispatchToolByName(
      'ui_run_scenario',
      {
        id: 'modal-single',
        target: { kind: 'modal', modalId: 'dashboard-pane-modal' },
      },
      CTX,
    );
    const singlePayload = JSON.parse((single as { output: string }).output);
    expect(singlePayload.ok).toBe(true);
    expect(singlePayload.mounted).toBe(true);
    expect(host.calls.at(-1)?.type).toBe('markdown');
  });

  test('RunScenario with target widget replaces an active plugin-layout widget for single-widget scenarios', async () => {
    const loaded = await loadScenarioCatalog(SCENARIOS_DIR);
    const catalog: ScenarioCatalog = {
      scenarios: new Map(loaded.scenarios),
      errors: loaded.errors,
    };
    catalog.scenarios.set(MODAL_SINGLE_DEF.id, MODAL_SINGLE_DEF);
    const host = createWidgetHostStub();
    wireDashboardBoot(catalog, host);

    const res = await dispatchToolByName(
      'ui_run_scenario',
      {
        id: 'modal-single',
        target: { kind: 'widget', widgetId: 'old-plugin-modal-widget' },
      },
      CTX,
    );
    const payload = JSON.parse((res as { output: string }).output);
    expect(payload.ok).toBe(true);
    expect(payload.mounted).toBe(true);
    expect(host.calls.at(-1)?.type).toBe('markdown');
  });

  test('RunScenario with dashboard-managed widget target stays explicit unsupported', async () => {
    const loaded = await loadScenarioCatalog(SCENARIOS_DIR);
    const catalog: ScenarioCatalog = {
      scenarios: new Map(loaded.scenarios),
      errors: loaded.errors,
    };
    catalog.scenarios.set(MODAL_SINGLE_DEF.id, MODAL_SINGLE_DEF);
    const host = createWidgetHostStub();
    wireDashboardBoot(catalog, host);

    const res = await dispatchToolByName(
      'ui_run_scenario',
      {
        id: 'modal-single',
        target: { kind: 'widget', widgetId: 'wd-log' },
      },
      CTX,
    );
    const payload = JSON.parse((res as { output: string }).output);
    expect(payload.ok).toBe(false);
    expect(payload.mounted).toBe(false);
    expect(payload.error).toMatch(/dashboard-managed/);
  });

  test('RunScenario with non-mount target kind returns the shared explicit unsupported reason', async () => {
    const loaded = await loadScenarioCatalog(SCENARIOS_DIR);
    const catalog: ScenarioCatalog = {
      scenarios: new Map(loaded.scenarios),
      errors: loaded.errors,
    };
    catalog.scenarios.set(MODAL_SINGLE_DEF.id, MODAL_SINGLE_DEF);
    const host = createWidgetHostStub();
    wireDashboardBoot(catalog, host);

    const res = await dispatchToolByName(
      'ui_run_scenario',
      {
        id: 'modal-single',
        target: { kind: 'input', inputId: 'chat-main' },
      },
      CTX,
    );
    const payload = JSON.parse((res as { output: string }).output);
    expect(payload.ok).toBe(false);
    expect(payload.mounted).toBe(false);
    expect(payload.error).toMatch(/not a mount container/);
    expect(payload.target).toEqual({ kind: 'input', inputId: 'chat-main' });
    expect(host.calls).toHaveLength(0);
  });

  test('Per-widget spawn failure is swallowed · dry-run summary still returned', async () => {
    const catalog = await loadScenarioCatalog(SCENARIOS_DIR);
    const brittleHost = {
      calls: [] as SpawnCall[],
      spawn: () => { throw new Error('simulated host failure'); },
    };
    registerScenarioRuntimes({
      getCatalog: () => catalog,
      onMount: (widgets) => {
        for (const w of widgets) {
          try { brittleHost.spawn(); brittleHost.calls.push({ type: w.type }); }
          catch { /* swallowed like dashboard.ts */ }
        }
      },
    });

    const res = await dispatchToolByName('ui_run_scenario', { id: 'dashboard-default' }, CTX);
    const payload = JSON.parse((res as { output: string }).output);
    expect(payload.ok).toBe(true);     // onMount returned (no throw) → ok
    expect(payload.mounted).toBe(true);
    expect(payload.widgets).toHaveLength(2); // summary preserved
    expect(brittleHost.calls).toHaveLength(0); // every spawn threw
  });

  test('GetScenarioSchema surfaces widgetTypes for a real catalog entry', async () => {
    const catalog = await loadScenarioCatalog(SCENARIOS_DIR);
    const host = createWidgetHostStub();
    wireDashboardBoot(catalog, host);

    const res = await dispatchToolByName('ui_get_scenario_schema', { id: 'heap-graph' }, CTX);
    const payload = JSON.parse((res as { output: string }).output);
    expect(payload.found).toBe(true);
    expect(payload.widgetTypes).toEqual(['hello-text', 'log']);
  });

  test('catalog-less boot (before load finishes) still registers tools · RunScenario returns ok:false', async () => {
    const host = createWidgetHostStub();
    wireDashboardBoot(undefined, host);

    const list = await dispatchToolByName('ui_list_scenarios', {}, CTX);
    expect(JSON.parse((list as { output: string }).output).scenarios).toEqual([]);

    const run = await dispatchToolByName('ui_run_scenario', { id: 'dashboard-default' }, CTX);
    const runPayload = JSON.parse((run as { output: string }).output);
    expect(runPayload.ok).toBe(false);
    expect(runPayload.error).toMatch(/catalog/);
    expect(host.calls).toHaveLength(0);
  });
});
