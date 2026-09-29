import type { SurfaceRegistry } from '../surface/index.js';
import {
  wireModalSurfaceAdapter,
  wireWidgetSurfaceAdapter,
} from '../surface/index.js';
import type { WidgetHost } from '../widgets/host.js';

export interface DashboardSurfaceRegistryWiringDeps {
  surfaceRegistry: SurfaceRegistry;
  widgetHost: WidgetHost;
  wireModal?: typeof wireModalSurfaceAdapter;
  wireWidget?: typeof wireWidgetSurfaceAdapter;
}

export function wireDashboardSurfaceRegistry(
  deps: DashboardSurfaceRegistryWiringDeps,
): void {
  (deps.wireModal ?? wireModalSurfaceAdapter)({ registry: deps.surfaceRegistry });
  (deps.wireWidget ?? wireWidgetSurfaceAdapter)({
    registry: deps.surfaceRegistry,
    widgetHost: deps.widgetHost,
  });
}
