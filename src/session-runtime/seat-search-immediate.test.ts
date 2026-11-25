import { expect, test } from 'bun:test';
import { resolveDynamicSessionNativeToolSpecs, resolveSessionSurfaceProfile, type SessionSurfaceId } from './index.js';
import { SEAT_IMMEDIATE_SEARCH_TOOLS, splitDeferredToolSpecs } from './tier-flip.js';

const SEAT_SURFACES: SessionSurfaceId[] = ['ops-ui/agent', 'ops-fleet/agent', 'control/agent', 'research/agent', 'coding/turn'];

test('Grep, Glob, ListDir, Read and DocsSearch are immediate on every seat surface', () => {
  for (const surfaceId of SEAT_SURFACES) {
    const surface = resolveSessionSurfaceProfile({ preferredSurfaceId: surfaceId });
    expect(surface.id).toBe(surfaceId);
    const specs = resolveDynamicSessionNativeToolSpecs({ userText: '', defaultFamilyIds: surface.defaultNativeFamilyIds, surfaceId });
    // A seat marks its coding tools coordinator-deferred; the search/read four must survive the split anyway.
    const split = splitDeferredToolSpecs(specs.map((spec) => ({ ...spec, coordinatorDefer: true })));
    const immediate = split.active.map((spec) => spec.name);
    for (const name of ['Grep', 'Glob', 'ListDir', 'Read', 'DocsSearch']) {
      expect({ surfaceId, name, immediate: immediate.includes(name) }).toEqual({ surfaceId, name, immediate: true });
      expect(split.deferred.map((entry) => entry.name)).not.toContain(name);
    }
  }
  expect([...SEAT_IMMEDIATE_SEARCH_TOOLS].sort()).toEqual(['DocsSearch', 'Glob', 'Grep', 'ListDir', 'Read']);
});

test('a seat turn dispatches DocsSearch through the session runtime (not only the Agent capsule)', async () => {
  const { dispatchSessionRuntimeTool } = await import('./index.js');
  // 빈 query = 도구 자체의 검증 오류 — 런타임이 DocsSearch 로 보냈다는 증거(«unknown tool» 이 아니다).
  const deps = {
    getToolRuntime: () => undefined,
    dispatchToolRuntime: async () => { throw new Error('runtime must not be used for DocsSearch'); },
    dispatchPluginTool: async () => ({ ok: false as const, error: 'plugin must not be used for DocsSearch' }),
  };
  await expect(dispatchSessionRuntimeTool('DocsSearch', { query: '' }, deps)).rejects.toThrow('query is required');
});
