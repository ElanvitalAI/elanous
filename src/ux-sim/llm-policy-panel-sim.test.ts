import { describe, expect, test } from 'bun:test';
import { runLlmPolicyPanelSim } from './llm-policy-panel-sim.js';
import { loadMockScenarioCatalog } from './mock-scenario-catalog.js';

describe('UX sim device — NEXUS-LLM-POLICY-PANEL (0.3.33 · OP #125562)', () => {
  test('all five panel cases pass against the real GET/PUT routes', async () => {
    const result = await runLlmPolicyPanelSim();
    expect(result.cases.map((c) => c.caseId)).toEqual([
      'owner-write-ok',
      'non-owner-rejected',
      'invalid-schema-previous-preserved',
      'concurrent-write',
      'missing-file-defaults',
    ]);
    expect(result.pass).toBe(true);
    const byId = new Map(result.cases.map((c) => [c.caseId, c]));
    expect(byId.get('non-owner-rejected')?.status).toBe(401);
    expect(byId.get('invalid-schema-previous-preserved')?.status).toBe(400);
  });

  test('rejection keeps the previous policy byte-for-byte and reports reasons', async () => {
    const result = await runLlmPolicyPanelSim();
    const rejected = result.cases.find((c) => c.caseId === 'invalid-schema-previous-preserved');
    expect(rejected?.pass).toBe(true);
    expect(rejected?.detail).toContain('errors=');
    expect(rejected?.detail).toMatch(/errors=[1-9]/);
  });

  test('concurrent puts both land 200 and the file settles on one atomic write', async () => {
    const result = await runLlmPolicyPanelSim();
    const race = result.cases.find((c) => c.caseId === 'concurrent-write');
    expect(race?.pass).toBe(true);
    expect(race?.detail).toMatch(/a=200 b=200 final=(12|15)/);
  });

  test('device catalog registers the panel device and its scenario entry', () => {
    const catalog = loadMockScenarioCatalog();
    const device = catalog.devices.find((d) => d.id === 'LLM-POLICY-PANEL-SIM');
    expect(device).toBeDefined();
    expect(device?.checklistCells).toContain('NEXUS-LLM-POLICY-PANEL');
    expect(device?.entryCommands).toContain('bun test src/ux-sim/llm-policy-panel-sim.test.ts');
    const scenario = catalog.scenarios.find((s) => s.id === 'LLM-POLICY-PANEL-SCENARIOS');
    expect(scenario?.device).toBe('LLM-POLICY-PANEL-SIM');
    expect(scenario?.tests).toContain('src/ux-sim/llm-policy-panel-sim.test.ts');
  });

  test('sim-world device catalog fragment pins version 32 membership', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const fragment = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../../catalog/sim-world-device-catalog-fragments/devices/MD-UX-SIM-LLM-POLICY-PANEL-SIM-TS.json', import.meta.url)),
        'utf8',
      ),
    ) as { id: string; versions: number[] };
    expect(fragment.id).toBe('MD-UX-SIM-LLM-POLICY-PANEL-SIM-TS');
    expect(fragment.versions).toEqual([32]);
  });
});
