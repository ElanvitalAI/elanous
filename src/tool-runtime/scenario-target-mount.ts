import type { SurfaceAddress } from '../surface/address.js';
import type { DeclarativeWidgetNode } from '../ui/declarative/index.js';
import { mountScenarioIntoModal } from './scenario-modal-mount.js';
import {
  mountScenarioIntoWidget,
  type ScenarioWidgetMountDeps,
} from './scenario-widget-mount.js';

export type ScenarioTargetMountDeps = ScenarioWidgetMountDeps;

export const RUN_SCENARIO_MOUNT_TARGET_KINDS = [
  'modal',
  'widget',
] as const;

export type RunScenarioMountTargetKind =
  typeof RUN_SCENARIO_MOUNT_TARGET_KINDS[number];

export function isRunScenarioMountTargetKind(
  kind: SurfaceAddress['kind'],
): kind is RunScenarioMountTargetKind {
  return kind === 'modal' || kind === 'widget';
}

export function unsupportedRunScenarioTargetError(target: SurfaceAddress): string {
  switch (target.kind) {
    case 'input':
      return `RunScenario: target kind "${target.kind}" is not a mount container; `
        + 'target binding currently mounts widgets and panes, not live input surfaces';
    case 'popover':
      return `RunScenario: target kind "${target.kind}" is transient and not a scenario mount destination`;
    case 'inline':
      return `RunScenario: target kind "${target.kind}" is a one-line inline surface and not a scenario mount destination`;
    case 'bg':
      return `RunScenario: target kind "${target.kind}" is a background/session surface and not a scenario mount destination`;
    case 'window':
    case 'pane':
      return `RunScenario: target kind "${target.kind}" is not a scenario mount destination`;
    case 'modal':
    case 'widget':
      return `RunScenario: target kind "${target.kind}" requires a mount helper, not unsupportedRunScenarioTargetError()`;
  }
}

export function mountScenarioIntoTarget(
  widgets: readonly DeclarativeWidgetNode[],
  target: SurfaceAddress,
  deps: ScenarioTargetMountDeps,
): { mounted: boolean; error?: string } {
  switch (target.kind) {
    case 'modal':
      return mountScenarioIntoModal(widgets, target.modalId, deps);
    case 'widget':
      return mountScenarioIntoWidget(widgets, target.widgetId, deps);
    case 'input':
    case 'popover':
    case 'inline':
    case 'bg':
    case 'window':
    case 'pane':
      return {
        mounted: false,
        error: unsupportedRunScenarioTargetError(target),
      };
  }
}
