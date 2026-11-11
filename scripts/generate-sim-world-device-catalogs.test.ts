import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadMockScenarioCatalog } from '../src/ux-sim/mock-scenario-catalog.js';
import { assertHistoricalDeviceCatalogSnapshots, buildDeviceCatalogSnapshots } from '../src/ux-sim/device-catalog-snapshot-fragments.js';
import { buildSimWorldDeviceCatalogSnapshots, generateSimWorldDeviceCatalogSnapshots } from './generate-sim-world-device-catalogs.js';

const repoRoot = resolve(import.meta.dir, '..');

test('device snapshot fragments preserve historical membership and derive current version from catalog modules', () => {
  const current = loadMockScenarioCatalog();
  const fragments = [
    { id: 'MD-LEGACY-ONLY', versions: [2] },
    { id: 'MD-CURRENT', versions: [3] },
  ];
  expect(buildDeviceCatalogSnapshots(fragments, 2, 3, ['MD-CURRENT'])).toEqual({
    '2': ['MD-LEGACY-ONLY'],
    '3': ['MD-CURRENT'],
  });
  expect(() => buildDeviceCatalogSnapshots(fragments, 2, 3, ['MD-CURRENT', 'MD-MISSING']))
    .toThrow('current device snapshot does not match catalog');
  expect(buildSimWorldDeviceCatalogSnapshots()[String(current.deviceCatalogVersion)])
    .toEqual(current.sourceModules.map(({ id }) => id).sort());
});

test('current membership derives from the catalog while historical versions match the checked-in baseline', () => {
  const catalog = loadMockScenarioCatalog();
  expect(existsSync(resolve(repoRoot, 'src/sim-world-device-catalogs.json'))).toBe(false);
  const baseline = JSON.parse(readFileSync(new URL('../src/sim-world-device-catalog-history.json', import.meta.url), 'utf8')) as Record<string, string[]>;
  const snapshots = buildSimWorldDeviceCatalogSnapshots();
  expect(snapshots[String(catalog.deviceCatalogVersion)]).toEqual(catalog.sourceModules.map(({ id }) => id).sort());
  assertHistoricalDeviceCatalogSnapshots(snapshots, baseline, 2, catalog.deviceCatalogVersion);
});

test('GCP architect fake world remains linked to its source module and device snapshots', () => {
  const catalog = loadMockScenarioCatalog();
  const moduleId = 'MD-UX-SIM-GCP-ARCHITECT-EXPAND-FAKE-WORLD-TS';
  const sourcePath = 'src/ux-sim/gcp-architect-expand-fake-world.ts';
  expect(catalog.devices.find(({ id }) => id === 'gcp-architect-expand-fake-world')?.implementation)
    .toContain(sourcePath);
  expect(catalog.sourceModules.find(({ id }) => id === moduleId)).toMatchObject({
    path: sourcePath,
    deviceIds: ['gcp-architect-expand-fake-world'],
  });
  const snapshots = buildSimWorldDeviceCatalogSnapshots();
  expect(snapshots['31']).toContain(moduleId);
  expect(snapshots[String(catalog.deviceCatalogVersion)]).toContain(moduleId);
});

test('GCP tiered design simulation is discoverable through the device catalog', () => {
  const catalog = loadMockScenarioCatalog();
  const sourcePath = 'src/ux-sim/gcp-architect-expand/tiered-design.ts';
  const moduleId = 'MD-UX-SIM-GCP-ARCHITECT-EXPAND-TIERED-DESIGN-TS';
  const deviceId = 'gcp-architect-tiered-design';
  expect(catalog.devices.find(({ id }) => id === deviceId)).toMatchObject({
    implementation: [sourcePath],
    tests: ['src/ux-sim/gcp-architect-expand/tiered-design.test.ts'],
  });
  expect(catalog.sourceModules.find(({ id }) => id === moduleId)).toMatchObject({
    path: sourcePath,
    deviceIds: [deviceId],
  });
  expect(buildSimWorldDeviceCatalogSnapshots()[String(catalog.deviceCatalogVersion)]).toContain(moduleId);
});

test('history generation preserves an already-finalized current version and rejects rewriting it', () => {
  const repo = mkdtempSync(join(tmpdir(), 'sim-world-history-preserve-'));
  const target = join(repo, 'history.json');
  const catalog = loadMockScenarioCatalog();
  const current = buildSimWorldDeviceCatalogSnapshots()[String(catalog.deviceCatalogVersion)]!;
  try {
    writeFileSync(target, `${JSON.stringify({ [String(catalog.deviceCatalogVersion)]: current }, null, 2)}\n`);
    generateSimWorldDeviceCatalogSnapshots(target, repoRoot);
    expect(JSON.parse(readFileSync(target, 'utf8'))[String(catalog.deviceCatalogVersion)]).toEqual(current);

    writeFileSync(target, `${JSON.stringify({ [String(catalog.deviceCatalogVersion)]: [] }, null, 2)}\n`);
    expect(() => generateSimWorldDeviceCatalogSnapshots(target, repoRoot))
      .toThrow(`finalized device snapshot cannot be rewritten: version=${catalog.deviceCatalogVersion}`);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('historical snapshots reject a retroactive device membership change, including version 5', () => {
  const catalog = loadMockScenarioCatalog();
  const currentVersion = catalog.deviceCatalogVersion;
  const simulatedNextVersion = currentVersion + 1;
  const baseline = JSON.parse(readFileSync(new URL('../src/sim-world-device-catalog-history.json', import.meta.url), 'utf8')) as Record<string, string[]>;
  expect(baseline['5']).not.toContain('MD-UX-SIM-HQ-MOVE-SIM-TS');
  const memberships = new Map<string, number[]>();
  for (const [version, ids] of Object.entries(baseline)) {
    for (const id of ids) {
      memberships.set(id, [...(memberships.get(id) ?? []), Number(version)]);
    }
  }
  for (const { id } of catalog.sourceModules) {
    const versions = memberships.get(id) ?? [];
    if (!versions.includes(simulatedNextVersion)) memberships.set(id, [...versions, simulatedNextVersion].sort((a, b) => a - b));
  }
  const newCurrentId = 'MD-UX-SIM-NEW-CURRENT-DEVICE-TS';
  memberships.set(newCurrentId, [simulatedNextVersion]);
  memberships.set('MD-UX-SIM-HQ-MOVE-SIM-TS', [...(memberships.get('MD-UX-SIM-HQ-MOVE-SIM-TS') ?? []), 5].sort((a, b) => a - b));
  const changed = buildDeviceCatalogSnapshots([...memberships].map(([id, versions]) => ({ id, versions })),
    2, simulatedNextVersion, [...catalog.sourceModules.map(({ id }) => id), newCurrentId]);
  expect(() => assertHistoricalDeviceCatalogSnapshots(changed, baseline, 2, simulatedNextVersion, currentVersion))
    .toThrow('historical device snapshot changed or missing from baseline: version=5');
  const previousVersionNotFinalized = { ...baseline };
  delete previousVersionNotFinalized[String(currentVersion)];
  const immutableUntilPrevious: Record<string, string[]> = { ...changed, '5': [...baseline['5']!] };
  expect(() => assertHistoricalDeviceCatalogSnapshots(immutableUntilPrevious, previousVersionNotFinalized, 2, simulatedNextVersion, currentVersion)).not.toThrow();
  const finalizedVersion = Math.max(...Object.keys(baseline).map(Number));
  const retroactivelyChangedPrevious: Record<string, string[]> = {
    ...immutableUntilPrevious,
    [String(finalizedVersion)]: [...immutableUntilPrevious[String(finalizedVersion)]!, newCurrentId].sort(),
  };
  expect(() => assertHistoricalDeviceCatalogSnapshots(retroactivelyChangedPrevious, baseline, 2, simulatedNextVersion, currentVersion))
    .toThrow(`historical device snapshot changed or missing from baseline: version=${finalizedVersion}`);
});

test('a finalized device catalog version rejects retroactive device membership', () => {
  const baseline = JSON.parse(readFileSync(new URL('../src/sim-world-device-catalog-history.json', import.meta.url), 'utf8')) as Record<string, string[]>;
  const snapshots = buildSimWorldDeviceCatalogSnapshots();
  const finalizedVersion = Math.max(...Object.keys(baseline).map(Number));
  const finalizedKey = String(finalizedVersion);
  expect(baseline[finalizedKey]).toBeDefined();
  const retroactive = { ...snapshots, [finalizedKey]: [...snapshots[finalizedKey]!, 'MD-UX-SIM-RETROACTIVE-DEVICE-TS'].sort() };
  expect(() => assertHistoricalDeviceCatalogSnapshots(retroactive, baseline, 2, finalizedVersion))
    .toThrow(`historical device snapshot changed or missing from baseline: version=${finalizedKey}`);
});

test('SIM-CATALOG-FRAGMENTS: merged catalog and device fragments derive current membership without editing the shared baseline', () => {
  const repo = mkdtempSync(join(tmpdir(), 'sim-world-device-fragments-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim();
  const originalRoot = resolve(import.meta.dir, '..');
  const deviceFragments = 'catalog/sim-world-device-catalog-fragments/devices';
  const catalogDevices = 'catalog/ux-sim/mock-scenario-catalog-fragments/devices';
  const sourceModules = 'catalog/ux-sim/mock-scenario-catalog-fragments/source-modules';
  const baselinePath = 'src/sim-world-device-catalog-history.json';
  const currentVersion = loadMockScenarioCatalog().deviceCatalogVersion;
  const nextVersion = currentVersion + 1;
  const writeDeviceFragment = (id: string, versions: number[]) => {
    const path = join(repo, deviceFragments, `${id}.json`);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ id, versions }, null, 2)}\n`);
  };
  const writeSourceModule = (suffix: 'PRE' | 'A' | 'B', addAtCurrentVersion = false) => {
    const deviceId = `merge-writer-${suffix.toLowerCase()}`;
    const sourcePath = `src/ux-sim/${deviceId}.ts`;
    const id = `MD-${sourcePath.replace(/^src\/ux-sim\//, 'UX-SIM-').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toUpperCase()}`;
    const slot = suffix === 'PRE' ? '99997' : suffix === 'A' ? '99998' : '99999';
    const metadataPath = join(repo, 'catalog/ux-sim/mock-scenario-catalog-fragments/metadata.json');
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as Record<string, unknown>;
    const membershipVersion = addAtCurrentVersion ? currentVersion : nextVersion;
    metadata.deviceCatalogVersion = membershipVersion;
    writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
    for (const name of readdirSync(join(repo, sourceModules)).filter((entry) => entry.endsWith('.json'))) {
      const module = JSON.parse(readFileSync(join(repo, sourceModules, name), 'utf8')) as { id: string };
      const fragmentPath = join(repo, deviceFragments, `${module.id}.json`);
      const fragment = JSON.parse(readFileSync(fragmentPath, 'utf8')) as { id: string; versions: number[] };
      const versionToAdd = addAtCurrentVersion ? currentVersion : nextVersion;
      if (!fragment.versions.includes(versionToAdd)) {
        fragment.versions = [...fragment.versions, versionToAdd].sort((a, b) => a - b);
        writeFileSync(fragmentPath, `${JSON.stringify(fragment, null, 2)}\n`);
      }
    }
    const device = JSON.parse(readFileSync(join(repo, catalogDevices, '00240--world-runtime-d26d02c9.json'), 'utf8')) as Record<string, unknown>;
    device.id = deviceId;
    device.name = `Merge writer ${suffix}`;
    device.implementation = [sourcePath];
    device.tests = [`src/ux-sim/${deviceId}.test.ts`];
    writeFileSync(join(repo, catalogDevices, `${slot}--${deviceId}.json`), `${JSON.stringify(device, null, 2)}\n`);
    writeFileSync(join(repo, sourceModules, `${slot}--${id.toLowerCase()}.json`), `${JSON.stringify({
      id, path: sourcePath, boundary: 'merge simulation source module', deviceIds: [deviceId],
      integrityCertificatePresent: false, integrityCertificatePath: null,
    }, null, 2)}\n`);
    writeDeviceFragment(id, [membershipVersion]);
    return id;
  };
  try {
    for (const path of ['catalog/sim-world-device-catalog-fragments', 'catalog/ux-sim/mock-scenario-catalog-fragments']) {
      cpSync(join(originalRoot, path), join(repo, path), { recursive: true });
    }
    mkdirSync(join(repo, 'src/ux-sim'), { recursive: true });
    mkdirSync(join(repo, 'src/primitives'), { recursive: true });
    cpSync(join(originalRoot, 'src/primitives/guards.ts'), join(repo, 'src/primitives/guards.ts'));
    cpSync(join(originalRoot, 'src/ux-sim/mock-scenario-catalog.ts'), join(repo, 'src/ux-sim/mock-scenario-catalog.ts'));
    cpSync(join(originalRoot, 'src/ux-sim/device-catalog-snapshot-fragments.ts'), join(repo, 'src/ux-sim/device-catalog-snapshot-fragments.ts'));
    cpSync(join(originalRoot, baselinePath), join(repo, baselinePath));
    const history = JSON.parse(readFileSync(join(repo, baselinePath), 'utf8')) as Record<string, string[]>;
    delete history[String(currentVersion)];
    writeFileSync(join(repo, baselinePath), `${JSON.stringify(history, null, 2)}\n`);
    const prePromotionId = writeSourceModule('PRE', true);
    mkdirSync(join(repo, 'scripts'), { recursive: true });
    cpSync(join(originalRoot, 'scripts/generate-sim-world-device-catalogs.ts'), join(repo, 'scripts/generate-sim-world-device-catalogs.ts'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Catalog simulator');
    git('config', 'user.email', 'catalog-sim@example.invalid');
    git('add', '.'); git('commit', '-qm', 'base snapshot fragment');
    const beforePromotion = buildSimWorldDeviceCatalogSnapshots(repo)[String(currentVersion)];
    expect(beforePromotion).toContain(prePromotionId);
    const currentSourceIds = readdirSync(join(repo, sourceModules)).filter((entry) => entry.endsWith('.json'))
      .map((name) => (JSON.parse(readFileSync(join(repo, sourceModules, name), 'utf8')) as { id: string }).id).sort();
    expect(beforePromotion).toEqual(currentSourceIds);
    const base = git('rev-parse', 'HEAD');
    git('checkout', '-qb', 'writer-a'); const writerA = writeSourceModule('A'); git('add', '.'); git('commit', '-qm', 'device A');
    git('checkout', '-q', base, '-b', 'writer-b'); const writerB = writeSourceModule('B'); git('add', '.'); git('commit', '-qm', 'device B');
    git('merge', '--no-edit', 'writer-a');
    expect(git('diff', '--name-only', '--diff-filter=U')).toBe('');
    const snapshots = buildSimWorldDeviceCatalogSnapshots(repo, { allowUnfinalizedPreviousVersion: true });
    expect(snapshots[String(currentVersion)]).toEqual(beforePromotion);
    expect(snapshots[String(nextVersion)]).toContain(writerA);
    expect(snapshots[String(nextVersion)]).toContain(writerB);
    expect(git('diff', '--name-only', base, 'HEAD').split('\n')).not.toContain(baselinePath);
    execFileSync('bun', ['scripts/generate-sim-world-device-catalogs.ts', '--refresh-history'], { cwd: repo, encoding: 'utf8', stdio: 'pipe' });
    const generated = JSON.parse(readFileSync(join(repo, baselinePath), 'utf8')) as Record<string, string[]>;
    expect(generated[String(currentVersion)]).toEqual(snapshots[String(currentVersion)]);
    expect(generated[String(currentVersion)]).toContain(prePromotionId);
    expect(generated[String(nextVersion)]).toBeUndefined();
    expect(readdirSync(join(repo, deviceFragments))).toContain(`${writerA}.json`);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
