import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { dashboardMatches, dashboardSourceLocations, readDashboardSources } from './helpers/dashboard-source.js';

const ROOT = process.cwd();

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8');
}

describe('R4 damage bridge source truth', () => {
  test('dashboard wires renderCoordinator before-flush into frame-cache row invalidation', () => {
    const sources = readDashboardSources();
    expect(dashboardMatches(/display\.renderCoordinatorAPI\(\)\.on\('before-flush'/, sources).length,
      `Missing before-flush in ${dashboardSourceLocations(sources)}`).toBeGreaterThan(0);
    expect(dashboardMatches(/buildDamageFromDirtyEntries\(ev\.entries, display\.layerTreeAPI\(\)\)/, sources).length,
      `Missing damage construction in ${dashboardSourceLocations(sources)}`).toBeGreaterThan(0);
    expect(dashboardMatches(/invalidateRowsForDamage\(damage, \(row0\) => invalidateRenderCacheRow\(row0\)\)/, sources).length,
      `Missing row invalidation in ${dashboardSourceLocations(sources)}`).toBeGreaterThan(0);
  });

  test('drag wire cleanup no longer depends on shouldResetRenderCache or forceFromDrag', () => {
    const sources = readDashboardSources();
    const dragWire = read('src/drag-session-dashboard-wire.ts');
    const popover = read('src/drop-zone-popover.ts');
    const forceFromDrag = dashboardMatches(/forceFromDrag/, sources);
    expect(forceFromDrag, `Unexpected forceFromDrag at ${forceFromDrag.map(({ path, line }) => `${path}:${line}`).join(', ')}`).toEqual([]);
    const shouldResetRenderCache = dashboardMatches(/shouldResetRenderCache/, sources);
    expect(shouldResetRenderCache,
      `Unexpected shouldResetRenderCache at ${shouldResetRenderCache.map(({ path, line }) => `${path}:${line}`).join(', ')}`).toEqual([]);
    expect(dashboardMatches(/transientOverlayHost\.prepareFrame\(\)/, sources).length,
      `Missing overlay preparation in ${dashboardSourceLocations(sources)}`).toBeGreaterThan(0);
    expect(dragWire.includes('shouldResetRenderCache')).toBe(false);
    expect(dragWire).toContain('prepareOverlayFrame()');
    expect(dragWire.includes('skipSelfErase')).toBe(false);
    expect(popover.includes('skipSelfErase')).toBe(false);
  });
});
