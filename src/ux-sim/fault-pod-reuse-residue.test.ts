import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { createPodReuseResidueFaultFixture } from './fault-pod-reuse-residue.js';
import { loadMockScenarioCatalog } from './mock-scenario-catalog.js';

test('injects independently observable Git, credential, and child-process inventory residue into a reused worker', () => {
  const fixture = createPodReuseResidueFaultFixture();
  try {
    const seeded = fixture.inject('prior-round');
    const residue = fixture.residue();

    expect(residue.gitStatus).toContain(`M README.md\0`);
    expect(residue.gitStatus).toContain(`?? ${seeded.untrackedPath}\0`);
    expect(residue.credentials).toEqual([fixture.runCredentialPath]);
    expect(residue.processes).toEqual([seeded.processId]);
    expect(fixture.remote.git(fixture.remote.checkout, ['rev-parse', 'HEAD']))
      .toBe(fixture.remote.git(fixture.remote.seed, ['rev-parse', 'HEAD']));
  } finally {
    fixture.cleanup();
  }
  expect(existsSync(fixture.remote.root)).toBe(false);
  expect(existsSync(fixture.runCredentialPath)).toBe(false);
});

test('requires a stable run ID and prevents accidental duplicate fault injection', () => {
  const fixture = createPodReuseResidueFaultFixture();
  try {
    expect(() => fixture.inject('../escape')).toThrow('safe slug');
    fixture.inject('round-1');
    expect(() => fixture.inject('round-1')).toThrow('already injected');
  } finally {
    fixture.cleanup();
  }
});

test('registers the device implementation and immutable world catalog snapshot', () => {
  const catalog = loadMockScenarioCatalog();
  const device = catalog.devices.find((entry) => entry.id === 'pod-reuse-residue-fault');
  expect(catalog.deviceCatalogVersion).toBe(6);
  expect(device?.implementation).toContain('src/ux-sim/fault-pod-reuse-residue.ts');
  expect(device?.tests).toContain('src/ux-sim/fault-pod-reuse-residue.test.ts');
  const sourceModuleId = 'MD-UX-SIM-FAULT-POD-REUSE-RESIDUE-TS';
  expect(catalog.sourceModules.some((entry) => entry.id === sourceModuleId)).toBe(true);
  const snapshots = JSON.parse(readFileSync(new URL('../sim-world-device-catalogs.json', import.meta.url), 'utf8')) as Record<string, string[]>;
  expect(snapshots['6']).toContain(sourceModuleId);
});
