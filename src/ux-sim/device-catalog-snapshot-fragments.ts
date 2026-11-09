import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadMockScenarioCatalogFromRoot } from './mock-scenario-catalog.js';

export interface DeviceCatalogSnapshotFragment {
  id: string;
  versions: number[];
}

export function assertHistoricalDeviceCatalogSnapshots(
  snapshots: Readonly<Record<string, readonly string[]>>,
  baseline: Readonly<Record<string, readonly string[]>>,
  firstVersion: number,
  currentVersion: number,
  allowMissingVersion?: number,
): void {
  for (let version = firstVersion; version <= currentVersion; version++) {
    const key = String(version);
    if (!baseline[key] && (version === currentVersion || version === allowMissingVersion)) continue;
    if (!baseline[key] || JSON.stringify(snapshots[key]) !== JSON.stringify(baseline[key]))
      throw new Error(`historical device snapshot changed or missing from baseline: version=${key}`);
  }
}

/** Rebuild immutable per-version device membership from independent per-device records. */
export function buildDeviceCatalogSnapshots(
  fragments: readonly DeviceCatalogSnapshotFragment[],
  firstVersion: number,
  currentVersion: number,
  currentDeviceIds: readonly string[],
): Record<string, string[]> {
  if (!Number.isSafeInteger(firstVersion) || firstVersion < 1 || !Number.isSafeInteger(currentVersion) || currentVersion < firstVersion)
    throw new Error('device catalog snapshot version range is invalid');
  const ids = new Set<string>();
  for (const fragment of fragments) {
    if (!/^MD-[A-Z0-9-]+$/.test(fragment.id)) throw new Error(`device snapshot fragment id is invalid: ${fragment.id}`);
    if (ids.has(fragment.id)) throw new Error(`duplicate device snapshot fragment id: ${fragment.id}`);
    ids.add(fragment.id);
    if (!Array.isArray(fragment.versions) || fragment.versions.length === 0
      || fragment.versions.some((version) => !Number.isSafeInteger(version) || version < firstVersion || version > currentVersion)
      || fragment.versions.some((version, index) => index > 0 && fragment.versions[index - 1]! >= version))
      throw new Error(`device snapshot fragment versions are invalid: ${fragment.id}`);
  }
  const snapshots: Record<string, string[]> = {};
  for (let version = firstVersion; version <= currentVersion; version++) {
    snapshots[String(version)] = fragments
      .filter(({ versions }) => versions.includes(version))
      .map(({ id }) => id)
      .sort();
  }
  const latest = snapshots[String(currentVersion)] ?? [];
  const current = [...currentDeviceIds].sort();
  if (new Set(current).size !== current.length) throw new Error('current device catalog contains duplicate IDs');
  if (JSON.stringify(latest) !== JSON.stringify(current)) {
    const latestSet = new Set(latest);
    const currentSet = new Set(current);
    const missing = current.filter((id) => !latestSet.has(id));
    const stale = latest.filter((id) => !currentSet.has(id));
    throw new Error(`current device snapshot does not match catalog: missing=${missing.join(',') || 'none'} stale=${stale.join(',') || 'none'}`);
  }
  return snapshots;
}

/** Load append-only device fragments, keeping every released historical snapshot immutable. */
export function loadDeviceCatalogSnapshotsFromRoot(repoRoot: string, options: { allowUnfinalizedPreviousVersion?: boolean } = {}): Record<string, string[]> {
  const fragmentsRoot = resolve(repoRoot, 'catalog/sim-world-device-catalog-fragments');
  const metadata = JSON.parse(readFileSync(resolve(fragmentsRoot, 'metadata.json'), 'utf8')) as { firstVersion?: unknown };
  if (!Number.isSafeInteger(metadata.firstVersion) || Number(metadata.firstVersion) < 1)
    throw new Error('device snapshot fragment metadata must declare a positive firstVersion');
  const fragments = readdirSync(resolve(fragmentsRoot, 'devices')).filter((name) => name.endsWith('.json')).sort().map((name) => {
    if (!/^MD-[A-Z0-9-]+\.json$/.test(name)) throw new Error(`device snapshot fragment filename is invalid: ${name}`);
    const fragment = JSON.parse(readFileSync(resolve(fragmentsRoot, 'devices', name), 'utf8')) as DeviceCatalogSnapshotFragment;
    if (`${fragment.id}.json` !== name) throw new Error(`device snapshot fragment filename does not match ID: ${name}`);
    return fragment;
  });
  const catalog = loadMockScenarioCatalogFromRoot(repoRoot);
  const snapshots = buildDeviceCatalogSnapshots(fragments, Number(metadata.firstVersion), catalog.deviceCatalogVersion,
    catalog.sourceModules.map(({ id }) => id));
  const baseline = JSON.parse(readFileSync(resolve(repoRoot, 'src/sim-world-device-catalog-history.json'), 'utf8')) as Record<string, string[]>;
  const unfinalizedPreviousVersion = options.allowUnfinalizedPreviousVersion ? catalog.deviceCatalogVersion - 1 : undefined;
  assertHistoricalDeviceCatalogSnapshots(snapshots, baseline, Number(metadata.firstVersion), catalog.deviceCatalogVersion, unfinalizedPreviousVersion);
  return snapshots;
}
