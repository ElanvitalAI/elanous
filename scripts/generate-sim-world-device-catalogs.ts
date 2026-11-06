import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadMockScenarioCatalog, type MockScenarioCatalog } from '../src/ux-sim/mock-scenario-catalog.js';

export type SimWorldDeviceCatalogSnapshots = Record<string, string[]>;

/** Preserve historical world versions and regenerate the current version from the canonical device catalog. */
export function updateSimWorldDeviceCatalogSnapshots(
  snapshots: SimWorldDeviceCatalogSnapshots,
  catalog: Pick<MockScenarioCatalog, 'deviceCatalogVersion' | 'sourceModules'>,
): SimWorldDeviceCatalogSnapshots {
  if (!Number.isSafeInteger(catalog.deviceCatalogVersion) || catalog.deviceCatalogVersion < 1)
    throw new Error('current device catalog version must be a positive integer');
  const ids = catalog.sourceModules.map(({ id }) => id);
  if (ids.some(id => typeof id !== 'string' || !id.trim()) || new Set(ids).size !== ids.length)
    throw new Error('current device catalog must contain unique non-empty module ids');
  return { ...snapshots, [String(catalog.deviceCatalogVersion)]: [...ids].sort() };
}

export function generateSimWorldDeviceCatalogSnapshots(
  snapshotPath = resolve(import.meta.dir, '../src/sim-world-device-catalogs.json'),
): void {
  const existing = JSON.parse(readFileSync(snapshotPath, 'utf8')) as SimWorldDeviceCatalogSnapshots;
  const updated = updateSimWorldDeviceCatalogSnapshots(existing, loadMockScenarioCatalog());
  writeFileSync(snapshotPath, `${JSON.stringify(updated, null, 2)}\n`);
}

if (import.meta.main) generateSimWorldDeviceCatalogSnapshots();
