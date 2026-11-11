import { expect, test } from 'bun:test';
import { assembleWorld, parseSimWorld } from './world.js';
import { createFakeAppFailures, type FakeAppFailuresDevice } from './fake-app-failures.js';

test('SIM-FAKE-APP-FAILURES injects stage, connector, and active app-version fixtures including an unknown error', () => {
  const world = assembleWorld({ spec: parseSimWorld(`world: app-failures
devices: [fake-app-failures]
apps:
  - slug: demo-app
    current: v2
    versions:
      - id: v1
        files: { index.html: old }
      - id: v2
        files: { index.html: current }
`) });
  const device = world.devices.get('fake-app-failures') as FakeAppFailuresDevice | undefined;

  expect(device).toBeDefined();
  const failures = device!.inject();
  expect(Object.isFrozen(failures)).toBe(true);
  expect(failures.every((failure) => failure.appId === 'demo-app' && failure.appVersion === 'v2')).toBe(true);
  expect(new Set(failures.map((failure) => failure.stage))).toEqual(new Set(['build', 'deploy', 'runtime']));
  expect(failures.every((failure) => failure.connector.length > 0 && failure.errorCode.length > 0)).toBe(true);
  expect(failures.filter((failure) => failure.classification === 'unknown')).toMatchObject([
    { id: 'demo-app:unknown-build-hook-shape', stage: 'build', connector: 'build-hook', appVersion: 'v2' },
  ]);
  expect(failures.find((failure) => failure.id === 'demo-app:runtime-server-errors')?.errorCode).toBe('http-5xx-repeat');
  expect(failures.find((failure) => failure.id === 'demo-app:runtime-credential-rejected')?.errorCode).toBe('credential-401');
  expect(device!.inject()).toEqual(failures);
});

test('SIM-FAKE-APP-FAILURES requires an app version and is registered in the assembled world', () => {
  expect(() => createFakeAppFailures([])).toThrow('fake app failure device requires a declared app');
  expect(() => createFakeAppFailures([{ slug: 'missing-version', versions: [] }])).toThrow('requires a declared app version');
  expect(() => createFakeAppFailures([{ slug: 'undeclared-current', current: 'v9', versions: [{ id: 'v1', files: {} }] }]))
    .toThrow('requires a declared app version');

  const assembled = assembleWorld({ spec: parseSimWorld('world: failures-only\ndevices: [fake-app-failures]\napps: [{ slug: demo, versions: [{ id: release-a, files: {} }] }]') });
  expect(assembled.appHost).toBeDefined();
  expect((assembled.devices.get('fake-app-failures') as FakeAppFailuresDevice).inject()[0]).toMatchObject({
    appId: 'demo', appVersion: 'release-a', stage: 'build', connector: 'static-export',
  });
});
