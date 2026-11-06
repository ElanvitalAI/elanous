import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { loadMockScenarioCatalog } from '../src/ux-sim/mock-scenario-catalog.js';
import { updateSimWorldDeviceCatalogSnapshots } from './generate-sim-world-device-catalogs.js';

test('device snapshot generator preserves history and derives the current version from catalog modules', () => {
  const current = loadMockScenarioCatalog();
  const history: Record<string, string[]> = { '2': ['legacy-b', 'legacy-a'], '5': ['version-five'] };
  const updated = updateSimWorldDeviceCatalogSnapshots(history, current);
  expect(updated['2']).toEqual(history['2']);
  expect(updated['5']).toEqual(history['5']);
  expect(updated[String(current.deviceCatalogVersion)]).toEqual(current.sourceModules.map(({ id }) => id).sort());
  expect(history[String(current.deviceCatalogVersion)]).toBeUndefined();
});

test('generated current snapshot exactly matches the checked-in canonical device catalog', () => {
  const catalog = loadMockScenarioCatalog();
  const snapshots = JSON.parse(readFileSync(new URL('../src/sim-world-device-catalogs.json', import.meta.url), 'utf8')) as Record<string, string[]>;
  expect(snapshots[String(catalog.deviceCatalogVersion)]).toEqual(catalog.sourceModules.map(({ id }) => id).sort());
});
