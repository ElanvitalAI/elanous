import { expect, test } from 'bun:test';
import { simCli } from '../ux-sim/in-process-cli.js';
import { loadMockScenarioCatalog } from '../ux-sim/mock-scenario-catalog.js';

test('sim devices --user-package exposes safe connector packages through the CLI', async () => {
  const result = await simCli(['sim', 'devices', '--user-package', '--json'], { allowPaths: [['sim', 'devices']] });
  expect(result.exitCode).toBe(0);
  const payload = JSON.parse(result.stdout) as { devices: Array<{ id: string; implementation: string[]; defaultProfile: { credentials: string; network: string; storage: string }; decisionCases: string[] }> };
  const expectedIds = loadMockScenarioCatalog().devices.filter((device) => device.audience === 'user').map((device) => device.id);
  expect(payload.devices.map((device) => device.id)).toEqual(expectedIds);
  expect(payload.devices.every((device) => device.implementation.length > 0 && device.decisionCases.length > 0)).toBe(true);
  expect(payload.devices.every((device) => device.defaultProfile.credentials === 'fake-only'
    && device.defaultProfile.network === 'loopback-only'
    && device.defaultProfile.storage === 'temporary')).toBe(true);
  expect(payload.devices.some((device) => device.id === 'release-graph-rig')).toBe(false);
  expect(result.stdout).not.toMatch(/recentUse|runId|secret|tokenValue|credentialValue/i);
});
