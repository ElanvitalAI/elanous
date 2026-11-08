import type { DashboardMouseWiring, DashboardMouseWiringDeps } from './mouse-wiring-types.js';

export interface DashboardMouseWiringModule {
  createDashboardMouseWiring(deps: DashboardMouseWiringDeps): DashboardMouseWiring;
}

// Keep the runtime import out of consumers' static program graphs. showDashboard
// still awaits this exact module before it wires mouse input and starts drawing.
const mouseWiringModulePath = ['./mouse-wiring', '.js'].join('');

export async function loadDashboardMouseWiring(): Promise<DashboardMouseWiringModule> {
  return await import(mouseWiringModulePath) as unknown as DashboardMouseWiringModule;
}
