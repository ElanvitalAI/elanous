import { expect, test } from 'bun:test';
import { buildMockScenarioUserPackage, loadMockScenarioCatalog, parseMockScenarioCatalog } from './mock-scenario-catalog.js';

const catalog = loadMockScenarioCatalog();

test('user package exposes only connector devices with the secret-free default profile and shared contracts', () => {
  const packaged = buildMockScenarioUserPackage(catalog);
  const packagedIds = packaged.map((device) => device.id).sort();
  expect(packagedIds).toEqual([
    'SIM-FAKE-PROVIDERS-AV', 'fake-app-auth', 'fake-app-drive-world', 'fake-app-realtime',
    'fake-app-storage', 'fake-app-traffic', 'fake-dns-cert', 'fake-google-drive-world',
    'fake-higgsfield', 'fake-payment', 'multi-actor-world',
  ].sort());
  expect(packaged.every((device) => device.defaultProfile.credentials === 'fake-only'
    && device.defaultProfile.network === 'loopback-only'
    && device.defaultProfile.storage === 'temporary')).toBe(true);
  expect(packaged.every((device) => device.implementation.length > 0)).toBe(true);
  expect(packaged.every((device) => device.decisionCases.length > 0)).toBe(true);
  expect(packaged.filter((device) => device.scenarios.length > 0).map((device) => device.id).sort())
    .toEqual(['fake-app-drive-world', 'fake-google-drive-world'].sort());
  for (const device of packaged) {
    const expectedScenarios = catalog.scenarios.filter((scenario) => scenario.device === device.id).map(({ id, name, kind, trigger, observe, expected }) => ({
      id, name, kind, trigger, observe, expected,
    }));
    expect(device.scenarios).toEqual(expectedScenarios);
  }
  expect(JSON.stringify(packaged)).not.toMatch(/recentUse|runId|secret|tokenValue|credentialValue/i);
  expect(packaged.some((device) => device.id === 'release-graph-rig')).toBe(false);
});

test('catalog rejects a user default profile with a live credential slot or altered safety defaults', () => {
  const invalid = structuredClone(catalog);
  const device = invalid.devices.find((row) => row.audience === 'user');
  expect(device).toBeDefined();
  device!.defaultProfile = { credentials: 'fake-only', network: 'loopback-only', storage: 'temporary', apiKey: '' } as never;
  expect(() => parseMockScenarioCatalog(invalid)).toThrow('secret-free fake-only, loopback-only, temporary profile');
});

test('package projection revalidates caller-provided profiles before serializing', () => {
  const untrusted = structuredClone(catalog);
  const device = untrusted.devices.find((row) => row.audience === 'user')!;
  device.defaultProfile = { credentials: 'fake-only', network: 'loopback-only', storage: 'temporary', apiKey: 'should-not-escape' } as never;
  expect(() => buildMockScenarioUserPackage(untrusted)).toThrow('secret-free fake-only, loopback-only, temporary profile');
});
