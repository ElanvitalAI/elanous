import type { LLMToolSpec } from '../llm/tool-spec.js';
import { loadMockScenarioCatalog } from '../ux-sim/mock-scenario-catalog.js';

import type { ToolRuntime } from './types.js';

export interface ElanousUxSimDevicesResult extends Record<string, unknown> {
  output: string;
  catalogVersion: number;
  devices: ReturnType<typeof loadMockScenarioCatalog>['devices'];
  scenarios: ReturnType<typeof loadMockScenarioCatalog>['scenarios'];
  runEvidence: ReturnType<typeof loadMockScenarioCatalog>['runEvidence'];
  candidateAudit: ReturnType<typeof loadMockScenarioCatalog>['candidateAudit'];
  discovery: ReturnType<typeof loadMockScenarioCatalog>['discovery'];
}

export function buildElanousUxSimDevicesTool(): LLMToolSpec {
  return {
    name: 'elanous_ux_sim_devices',
    description: 'Read the canonical mock/test-device catalog, including entry commands, logs/event evidence, recent-use metadata, and reusable scenarios. This lookup is read-only and never executes a device.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  };
}

export function dispatchElanousUxSimDevices(): ElanousUxSimDevicesResult {
  const catalog = loadMockScenarioCatalog();
  return {
    output: `Mock/test catalog v${catalog.version}: ${catalog.devices.length} devices, ${catalog.scenarios.length} scenarios. Read-only; use the catalog entry command to run a device.`,
    catalogVersion: catalog.version,
    devices: catalog.devices,
    scenarios: catalog.scenarios,
    runEvidence: catalog.runEvidence,
    candidateAudit: catalog.candidateAudit,
    discovery: catalog.discovery,
  };
}

export const elanousUxSimDevicesRuntime: ToolRuntime<Record<string, unknown>, ElanousUxSimDevicesResult> = {
  id: 'elanous_ux_sim_devices',
  spec: buildElanousUxSimDevicesTool(),
  async run() {
    return dispatchElanousUxSimDevices();
  },
  surfaces: ['mcp'],
};
