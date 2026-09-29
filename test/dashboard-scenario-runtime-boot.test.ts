import { describe, expect, mock, test } from 'bun:test';

import {
  DASHBOARD_SCENARIO_MANAGED_WIDGET_IDS,
  loadDashboardScenarioCatalog,
  registerDashboardScenarioRuntimes,
} from '../src/dashboard/scenario-runtime-boot.js';

describe('dashboard scenario runtime boot', () => {
  test('loadDashboardScenarioCatalog loads with last-wins duplicate policy and swallows errors', async () => {
    const loadOk = mock(async (_dir: string, opts: { onDuplicate: string }) => ({
      scenarios: new Map(),
      errors: [],
      opts,
    }));
    const loadFail = mock(async () => {
      throw new Error('missing');
    });

    const loaded = await loadDashboardScenarioCatalog('/tmp/scenarios', loadOk as never);
    const missing = await loadDashboardScenarioCatalog('/tmp/missing', loadFail as never);

    expect(loadOk).toHaveBeenCalledWith('/tmp/scenarios', { onDuplicate: 'last-wins' });
    expect(loaded).toEqual({
      scenarios: new Map(),
      errors: [],
      opts: { onDuplicate: 'last-wins' },
    });
    expect(missing).toBeUndefined();
  });

  test('registerDashboardScenarioRuntimes mounts inline widgets and swallows per-widget spawn errors', () => {
    let capturedDeps: { onMount: (widgets: readonly any[], target?: any) => { mounted: boolean; error?: string } } | null = null;
    const spawnWidget = mock((spec: { type: string }) => {
      if (spec.type === 'bad') throw new Error('bad');
      return { id: `widget:${spec.type}` };
    });

    registerDashboardScenarioRuntimes({
      scenarioCatalog: undefined,
      spawnWidget: spawnWidget as never,
      disposeWidget: mock((_id: string) => {}),
      getDashboardModals: () => [],
      setDashboardModals: mock((_modals: unknown[]) => {}),
      getPluginLayout: () => null,
      setPluginLayout: mock((_layout: unknown) => {}),
      registerScenario: ((deps) => { capturedDeps = deps as never; }) as never,
    });

    expect(capturedDeps).not.toBeNull();
    const result = capturedDeps!.onMount([
      { type: 'good', id: 'a', config: { x: 1 } },
      { type: 'bad' },
    ]);

    expect(result).toEqual({ mounted: true });
    expect(spawnWidget).toHaveBeenCalledWith(expect.objectContaining({
      type: 'good',
      id: 'a',
      config: { x: 1 },
    }));
    expect(spawnWidget).toHaveBeenCalledWith(expect.objectContaining({ type: 'bad' }));
  });

  test('real modal and widget mounts use dashboard dependencies, while non-mount targets are rejected', () => {
    let onMount!: (widgets: readonly any[], target?: any) => { mounted: boolean; error?: string };
    let modals = [{ id: 'm-1', widgetInstanceId: 'old' }];
    const disposed: string[] = [];
    registerDashboardScenarioRuntimes({
      scenarioCatalog: undefined,
      spawnWidget: ({ type }) => ({ id: `new-${type}` }),
      disposeWidget: (id) => { disposed.push(id); },
      getDashboardModals: () => modals as never,
      setDashboardModals: (next) => { modals = [...next] as typeof modals; },
      getPluginLayout: () => null,
      setPluginLayout: () => {},
      registerScenario: ((deps) => { onMount = deps.onMount; }) as never,
    });
    expect(onMount([{ type: 'good' }], { kind: 'modal', modalId: 'm-1' })).toEqual({ mounted: true });
    expect(modals[0]?.widgetInstanceId).toBe('new-good');
    expect(disposed).toEqual(['old']);
    expect(onMount([{ type: 'next' }], { kind: 'widget', widgetId: 'new-good' })).toEqual({ mounted: true });
    expect(modals[0]?.widgetInstanceId).toBe('new-next');
    expect(disposed).toEqual(['old', 'new-good']);
    expect(onMount([{ type: 'other' }], { kind: 'widget', widgetId: DASHBOARD_SCENARIO_MANAGED_WIDGET_IDS[0] })).toMatchObject({ mounted: false });
    for (const target of [{ kind: 'window', windowId: 1 }, { kind: 'pane', ref: { windowId: 1, paneId: 'p' } }]) {
      expect(onMount([{ type: 'good' }], target)).toEqual({
        mounted: false,
        error: `RunScenario: target kind "${target.kind}" is not a scenario mount destination`,
      });
    }
    expect(onMount([{ type: 'good' }], { kind: 'input' })).toMatchObject({ mounted: false });
  });
});
