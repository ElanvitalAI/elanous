import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { tuiSourceText } from './helpers/dashboard-source.js';

const DISPATCHER_TS = join(import.meta.dir, '..', 'src', 'input-core', 'dispatcher.ts');
const HIT_TEST_TS = join(import.meta.dir, '..', 'src', 'input-core', 'hit-test.ts');

describe('R9.U-2/U-3 source truth', () => {
  test('input-core dispatcher modules are present', () => {
    const dispatcher = readFileSync(DISPATCHER_TS, 'utf8');
    const hitTest = readFileSync(HIT_TEST_TS, 'utf8');
    expect(dispatcher).toContain('export function routeInputEvent(');
    expect(dispatcher).toContain('export async function routeInputEventAsync(');
    expect(hitTest).toContain('export function hitTestAllSurfaces(');
  });

  test('dashboard has four production mouse bridge call sites', () => {
    const src = tuiSourceText();
    const hits = src.match(/inputCoreBuildMouseEventFromDisplay\(/g) ?? [];
    expect(hits.length).toBe(4);
  });

  test('dashboard has no inline unknown-target mouse literal left', () => {
    const src = tuiSourceText();
    expect(src).not.toContain("target: { kind: 'unknown' }");
    expect(src).not.toContain("events use target:'unknown' for now");
  });

  test('dashboard has unified dispatcher production call sites for sync and async paths', () => {
    const src = tuiSourceText();
    const syncHits = src.match(/inputCoreRouteInputEvent\(/g) ?? [];
    const asyncHits = src.match(/inputCoreRouteInputEventAsync\(/g) ?? [];
    expect(syncHits.length).toBeGreaterThanOrEqual(3);
    expect(asyncHits.length).toBeGreaterThanOrEqual(4);
  });

  test('prod dispatch source no longer advertises env-flag rollback or legacy target fallback', () => {
    const dashboard = tuiSourceText();
    const dispatcher = readFileSync(DISPATCHER_TS, 'utf8');
    expect(dashboard).not.toContain('UNIFIED_DISPATCH=0');
    expect(dispatcher).not.toContain('UNIFIED_DISPATCH=0');
  });
});
