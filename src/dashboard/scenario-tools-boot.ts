import { loadScenarioCatalog, type ScenarioCatalog } from '../scenarios/index.js';
import {
  registerScenarioRuntimes,
  type ScenarioRuntimeDeps,
} from '../tool-runtime/scenario-runtimes.js';

export interface DashboardScenarioToolsBootDeps {
  scenarioDir: string;
  loadCatalog?: typeof loadScenarioCatalog;
  register?: typeof registerScenarioRuntimes;
}

export async function bootDashboardScenarioTools(
  deps: DashboardScenarioToolsBootDeps,
): Promise<ScenarioCatalog | undefined> {
  let catalog: ScenarioCatalog | undefined;
  try {
    catalog = await (deps.loadCatalog ?? loadScenarioCatalog)(deps.scenarioDir, {
      onDuplicate: 'last-wins',
    });
  } catch {
    catalog = undefined;
  }

  const runtimeDeps: ScenarioRuntimeDeps = { getCatalog: () => catalog };
  try {
    (deps.register ?? registerScenarioRuntimes)(runtimeDeps);
  } catch {
    // Dashboard boot remains available if the optional scenario tools fail.
  }
  return catalog;
}
