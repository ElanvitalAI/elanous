import { expect, test } from 'bun:test';
import { handleMcpRequest } from '../mcp/server.js';
import { nativeToolCatalog } from '../native-tool-catalog.js';
import { loadMockScenarioCatalog } from '../ux-sim/mock-scenario-catalog.js';
import { _resetToolRuntimeRegistryForTest } from './registry.js';
import {
  buildElanousUxSimDevicesTool,
  dispatchElanousUxSimDevices,
  elanousUxSimDevicesRuntime,
} from './elanous-ux-sim-devices-runtime.js';

test('MCP catalog runtime exposes one read-only no-argument tool with the full JSON source', async () => {
  const entries = nativeToolCatalog.filter((entry) => entry.id === 'elanous_ux_sim_devices');
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ host: ['mcp'], safety: ['read-only'], defaultEnabled: true });
  expect(elanousUxSimDevicesRuntime.id).toBe('elanous_ux_sim_devices');
  expect(elanousUxSimDevicesRuntime.surfaces).toEqual(['mcp']);
  expect(buildElanousUxSimDevicesTool()).toMatchObject({
    name: 'elanous_ux_sim_devices',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  });
  const expected = loadMockScenarioCatalog();
  const result = await elanousUxSimDevicesRuntime.run({}, { surface: 'mcp' });
  expect(result).toMatchObject({
    catalogVersion: expected.version,
    devices: expected.devices,
    scenarios: expected.scenarios,
    runEvidence: expected.runEvidence,
    candidateAudit: expected.candidateAudit,
    discovery: expected.discovery,
  });
  expect(dispatchElanousUxSimDevices().devices).toHaveLength(expected.devices.length);
});

test('real MCP tools/list and tools/call return the full canonical catalog to clients', async () => {
  _resetToolRuntimeRegistryForTest();
  const expected = loadMockScenarioCatalog();

  const listed = await handleMcpRequest({ jsonrpc: '2.0', id: 41, method: 'tools/list' });
  expect(listed.error).toBeUndefined();
  const tools = (listed.result as { tools: Array<{ name: string; inputSchema: unknown }> }).tools;
  expect(tools.find((tool) => tool.name === 'elanous_ux_sim_devices')).toMatchObject({
    name: 'elanous_ux_sim_devices',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  });

  const called = await handleMcpRequest({
    jsonrpc: '2.0', id: 42, method: 'tools/call',
    params: { name: 'elanous_ux_sim_devices', arguments: {} },
  });
  expect(called.error).toBeUndefined();
  const result = called.result as {
    content: Array<{ type: string; text: string }>;
    structuredContent: Record<string, unknown>;
  };
  // Check the client-visible protocol envelope, not just the runtime dispatcher.
  expect(result.content[0]?.type).toBe('text');
  expect(result.content[0]?.text).toContain(`${expected.devices.length} devices`);
  expect(result.structuredContent).toMatchObject({
    catalogVersion: expected.version,
    devices: expected.devices,
    scenarios: expected.scenarios,
    runEvidence: expected.runEvidence,
    candidateAudit: expected.candidateAudit,
    discovery: expected.discovery,
  });
  expect((result.structuredContent.devices as Array<{ id: string }>).map((device) => device.id))
    .toEqual(expected.devices.map((device) => device.id));
});
