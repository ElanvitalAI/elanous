import { describe, expect, test } from 'bun:test';
import { bootDashboardScenarioTools } from '../src/dashboard/scenario-tools-boot.js';
import { createRunScenarioRuntime, type ScenarioRuntimeDeps } from '../src/tool-runtime/scenario-runtimes.js';
import type { ScenarioCatalog } from '../src/scenarios/index.js';

describe('classic dashboard scenario TUI cut', () => {
  test('dashboard boot registers shared scenario tools without a TUI mount callback', async () => {
    const catalog: ScenarioCatalog = {
      scenarios: new Map([['hello', {
        id: 'hello',
        title: 'Hello',
        layout: { widget: 'log', config: { lines: ['hi'] } },
      }]]),
      errors: [],
    };
    let captured: ScenarioRuntimeDeps | undefined;

    const loaded = await bootDashboardScenarioTools({
      scenarioDir: '/unused/scenarios',
      loadCatalog: async () => catalog,
      register: (deps) => { captured = deps; },
    });

    expect(loaded).toBe(catalog);
    expect(captured?.getCatalog()).toBe(catalog);
    expect(captured).not.toHaveProperty('onMount');

    const result = await createRunScenarioRuntime(captured!).run(
      { id: 'hello' },
      { surface: 'dashboard' },
    );
    expect(JSON.parse(result.output)).toMatchObject({
      ok: true,
      id: 'hello',
      mounted: false,
      widgets: [{ type: 'log' }],
    });
  });
});
