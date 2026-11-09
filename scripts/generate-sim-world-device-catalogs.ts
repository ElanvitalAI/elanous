import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadDeviceCatalogSnapshotsFromRoot } from '../src/ux-sim/device-catalog-snapshot-fragments.js';
import { loadMockScenarioCatalogFromRoot } from '../src/ux-sim/mock-scenario-catalog.js';

export type SimWorldDeviceCatalogSnapshots = Record<string, string[]>;
export function buildSimWorldDeviceCatalogSnapshots(
  repoRoot = resolve(import.meta.dir, '..'),
  options: { allowUnfinalizedPreviousVersion?: boolean } = {},
): SimWorldDeviceCatalogSnapshots {
  return loadDeviceCatalogSnapshotsFromRoot(repoRoot, options);
}

export function generateSimWorldDeviceCatalogSnapshots(
  snapshotPath = resolve(import.meta.dir, '../src/sim-world-device-catalog-history.json'),
  repoRoot = resolve(import.meta.dir, '..'),
  options: { allowUnfinalizedPreviousVersion?: boolean } = {},
): void {
  const updated = buildSimWorldDeviceCatalogSnapshots(repoRoot, options);
  const currentVersion = loadMockScenarioCatalogFromRoot(repoRoot).deviceCatalogVersion;
  if (existsSync(snapshotPath)) {
    const existing = JSON.parse(readFileSync(snapshotPath, 'utf8')) as Record<string, string[]>;
    const currentKey = String(currentVersion);
    if (existing[currentKey]) {
      if (JSON.stringify(existing[currentKey]) !== JSON.stringify(updated[currentKey]))
        throw new Error(`finalized device snapshot cannot be rewritten: version=${currentKey}`);
      updated[currentKey] = existing[currentKey]!;
    } else {
      delete updated[currentKey];
    }
  } else {
    delete updated[String(currentVersion)];
  }
  writeFileSync(snapshotPath, `${JSON.stringify(updated, null, 2)}\n`);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const refreshHistory = args.includes('--refresh-history');
  const check = args.includes('--check');
  if (args.some((arg) => arg !== '--refresh-history' && arg !== '--check') || (refreshHistory && check)) {
    console.error('usage: bun scripts/generate-sim-world-device-catalogs.ts [--check | --refresh-history]');
    process.exitCode = 1;
  } else if (check) {
    buildSimWorldDeviceCatalogSnapshots();
  } else {
    generateSimWorldDeviceCatalogSnapshots(undefined, undefined, { allowUnfinalizedPreviousVersion: refreshHistory });
  }
}
