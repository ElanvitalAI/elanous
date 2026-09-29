import { describe, expect, mock, test } from 'bun:test';

import { createLayout } from '../src/layout/host.js';
import type { ModalPlacement } from '../src/layout/types.js';
import {
  isRunScenarioMountTargetKind,
  mountScenarioIntoTarget,
  RUN_SCENARIO_MOUNT_TARGET_KINDS,
  unsupportedRunScenarioTargetError,
} from '../src/tool-runtime/scenario-target-mount.js';

function makeDeps() {
  let dashboardModals: ModalPlacement[] = [{ id: 'picker', widgetInstanceId: 'old-widget', position: 'center' }];
  let pluginLayout = createLayout(
    [{ height: 'flex', cells: [{ widgetInstanceId: 'plugin-widget', width: 'flex' }] }],
    [],
  );

  return {
    spawnWidget: () => ({ id: 'new-widget' }),
    disposeWidget: () => {},
    getDashboardModals: () => dashboardModals,
    setDashboardModals: (modals: readonly ModalPlacement[]) => { dashboardModals = [...modals]; },
    getPluginLayout: () => pluginLayout,
    setPluginLayout: (layout: typeof pluginLayout) => { pluginLayout = layout; },
    getDashboardManagedWidgetIds: () => ['wd-log'],
  };
}

describe('scenario-target-mount', () => {
  test('mount target kind roster is explicit and closed', () => {
    expect(RUN_SCENARIO_MOUNT_TARGET_KINDS).toEqual([
      'modal',
      'widget',
    ]);
    expect(isRunScenarioMountTargetKind('window')).toBe(false);
    expect(isRunScenarioMountTargetKind('pane')).toBe(false);
    expect(isRunScenarioMountTargetKind('modal')).toBe(true);
    expect(isRunScenarioMountTargetKind('widget')).toBe(true);
    expect(isRunScenarioMountTargetKind('input')).toBe(false);
    expect(isRunScenarioMountTargetKind('popover')).toBe(false);
  });

  test('input/popover/inline/bg targets stay explicit unsupported with stable reasons', () => {
    expect(unsupportedRunScenarioTargetError({ kind: 'input', inputId: 'chat-main' })).toMatch(/not a mount container/);
    expect(unsupportedRunScenarioTargetError({ kind: 'popover', popoverId: 'pill' })).toMatch(/transient/);
    expect(unsupportedRunScenarioTargetError({ kind: 'inline', inlineId: 'runner' })).toMatch(/one-line inline surface/);
    expect(unsupportedRunScenarioTargetError({ kind: 'bg', bgId: 'job-1' })).toMatch(/background\/session surface/);
  });

  test('window and pane targets do not mount or spawn widgets', () => {
    const deps = makeDeps();
    const spawnWidget = mock(deps.spawnWidget);
    deps.spawnWidget = spawnWidget;
    for (const target of [
      { kind: 'window' as const, windowId: 1 },
      { kind: 'pane' as const, ref: { windowId: '1', paneId: 'pane-1' } },
    ]) {
      expect(mountScenarioIntoTarget([{ type: 'markdown', config: { text: 'hello' } }], target, deps)).toEqual({
        mounted: false,
        error: `RunScenario: target kind "${target.kind}" is not a scenario mount destination`,
      });
    }
    expect(spawnWidget).not.toHaveBeenCalled();
  });

  test('non-mount target kind returns shared unsupported error from the dispatcher', () => {
    const deps = makeDeps();
    const result = mountScenarioIntoTarget(
      [{ type: 'markdown', config: { text: 'hello' } }],
      { kind: 'popover', popoverId: 'pp-1' },
      deps,
    );
    expect(result).toEqual({
      mounted: false,
      error: 'RunScenario: target kind "popover" is transient and not a scenario mount destination',
    });
  });

  test('modal and widget targets still dispatch through their mount helpers', () => {
    const deps = makeDeps();
    expect(mountScenarioIntoTarget(
      [{ type: 'log', config: { lines: ['> ready'] } }],
      { kind: 'modal', modalId: 'picker' },
      deps,
    )).toEqual({ mounted: true });
    expect(mountScenarioIntoTarget(
      [{ type: 'log', config: { lines: ['> next'] } }],
      { kind: 'widget', widgetId: 'new-widget' },
      deps,
    )).toEqual({ mounted: true });
  });
});
