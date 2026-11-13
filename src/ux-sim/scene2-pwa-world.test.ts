import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDeviceCatalogSnapshotsFromRoot } from './device-catalog-snapshot-fragments.js';
import { loadMockScenarioCatalogFromRoot } from './mock-scenario-catalog.js';
import { runScene2PwaWorld } from './fake-absorb-ingest.js';

for (const failExtraction of [false, true]) {
  test(`Scene 2 catalog world preserves graph IDs; extractor failure=${failExtraction}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'scene2-pwa-'));
    try {
      const runId = failExtraction ? 's2-extractor-denied' : 's2-same-run';
      const receipt = await runScene2PwaWorld({ root, runId, failExtraction });
      expect(receipt.worldId).toBe('demo1114-s2-pwa');
      expect(receipt.result.runId).toBe(runId);
      expect(receipt.events.every(row => row.runId === runId && row.scrapId === `${runId}:scrap`)).toBe(true);
      const manifest = JSON.parse(readFileSync(join(receipt.worldRoot, 'world.json'), 'utf8'));
      expect(manifest.deviceModuleIds).toContain('MD-UX-SIM-FAKE-ABSORB-INGEST-TS');
      if (failExtraction) {
        expect(receipt.result.status).toBe('failed');
        expect(receipt.result.path).not.toContain('brief');
        expect(receipt.briefings).toEqual([]);
        expect(receipt.events.some(row => row.event === 'extractor-failed' && row.message?.includes('simulated web extractor failure'))).toBe(true);
      } else {
        expect(receipt.result.status).toBe('done');
        expect(receipt.events.map(row => row.event)).toEqual(['utterance', 'scrap', 'extract', 'brief']);
        expect(receipt.briefings).toEqual([{ id: `${runId}:briefing`, memberId: 'scene2-member', day: '2026-11-14', runId,
          topics: [{ title: 'Web article', summary: 'fixture extraction for web', scrapIds: [`${runId}:scrap`] }] }]);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test('same-root catalog snapshot drift refuses a missing Scene 2 device (A77 counterexample)', async () => {
  const { cpSync, writeFileSync } = await import('node:fs');
  const root = mkdtempSync(join(tmpdir(), 'scene2-catalog-drift-'));
  const source = join(import.meta.dir, '../..');
  try {
    cpSync(join(source, 'catalog'), join(root, 'catalog'), { recursive: true });
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(root, 'src'));
    cpSync(join(source, 'src/sim-world-device-catalog-history.json'), join(root, 'src/sim-world-device-catalog-history.json'));
    const version = loadMockScenarioCatalogFromRoot(root).deviceCatalogVersion;
    // One root supplies both inputs. No old executable/new checkout mixture is needed to reproduce drift.
    expect(loadDeviceCatalogSnapshotsFromRoot(root)[String(version)]).toContain('MD-UX-SIM-FAKE-ABSORB-INGEST-TS');
    const fragment = join(root, 'catalog/sim-world-device-catalog-fragments/devices/MD-UX-SIM-FAKE-ABSORB-INGEST-TS.json');
    const data = JSON.parse(readFileSync(fragment, 'utf8'));
    data.versions = data.versions.filter((item: number) => item !== version);
    writeFileSync(fragment, JSON.stringify(data));
    expect(() => loadDeviceCatalogSnapshotsFromRoot(root)).toThrow('current device snapshot does not match catalog: missing=MD-UX-SIM-FAKE-ABSORB-INGEST-TS stale=none');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
