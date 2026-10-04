import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { nativeToolCatalog } from '../src/native-tool-catalog.js';
import { SELF_COGNITION_MCP_CATALOG_ENTRIES } from '../src/tool-runtime/self-cognition-runtimes.js';
import { buildDashboardSlashRegistry } from '../src/dashboard/slash-runtime/index.js';
import retiredCatalogIds from '../docs/measurements/NTC1-retired-native-tool-ids.json';

describe('HT3 — native-tool wiring lint', () => {
  test('script exists + imports cleanly', async () => {
    const path = resolve(import.meta.dir, '..', 'scripts', 'check-native-tool-wiring.ts');
    const body = readFileSync(path, 'utf8');
    expect(body).toContain('nativeToolCatalog');
    expect(body).toContain('SKIP_TOOLS');
    expect(body).toContain('--strict');
  });

  test('HT1/HT2 tools are wired in skill-runner dispatch', () => {
    const runner = readFileSync(resolve(import.meta.dir, '..', 'src/skills/runner.ts'), 'utf8');
    expect(runner).toMatch(/\bDashboardViewSwitch:\s*async/);
    expect(runner).toMatch(/\bDashboardWidgetInvoke:\s*async/);
  });

  test('HT1/HT2 catalog entries exist with expected host exposure axis', () => {
    const viewSwitch = nativeToolCatalog.find(e => e.id === 'dashboard_view_switch');
    const widgetInvoke = nativeToolCatalog.find(e => e.id === 'dashboard_widget_invoke');
    expect(viewSwitch).toBeDefined();
    expect(viewSwitch!.host).toEqual(['skill']);
    expect(widgetInvoke).toBeDefined();
    expect(widgetInvoke!.host).toEqual(['skill']);
    expect(widgetInvoke!.minTier).toBe('T2');
  });

  test('self-implement P2 — catalog entry + registration wired', () => {
    const si = nativeToolCatalog.find(e => e.id === 'self_implement');
    expect(si).toBeDefined();
    expect(si!.aliases).toContain('SelfImplement');
    expect(si!.alwaysLoad).toBe(true);
    expect(si!.shouldDefer).toBe(false);
    const implementationCatalogEntries = nativeToolCatalog.slice(SELF_COGNITION_MCP_CATALOG_ENTRIES.length);
    const nonDeferredImplementationEntries = implementationCatalogEntries.filter(e => e.shouldDefer === false);
    expect(nonDeferredImplementationEntries).toHaveLength(1);
    expect(nonDeferredImplementationEntries[0]!.id).toBe('self_implement');
    expect(si!.defaultEnabled).toBe(true);
    expect(si!.safety).toContain('agent');
    // registered in registerAllDefaultToolRuntimes()
    const idx = readFileSync(resolve(import.meta.dir, '..', 'src/tool-runtime/index.ts'), 'utf8');
    expect(idx).toMatch(/registerToolRuntime\(selfImplementRuntime\)/);
    // /harness slash secondary surface is present in the runtime registry.
    const slashRegistry = buildDashboardSlashRegistry();
    expect(slashRegistry.names()).toContain('harness');
  });

  test('self-implement P2 — implementation catalog ID inventory', () => {
    const implementationCatalogEntries = nativeToolCatalog.slice(SELF_COGNITION_MCP_CATALOG_ENTRIES.length);
    const ids = implementationCatalogEntries.map(entry => entry.id);
    expect(ids).toHaveLength(178);
    expect(new Set(ids).size).toBe(ids.length);
    expect(Object.keys(retiredCatalogIds).sort()).toEqual(['baselineIds', 'retiredIds']);
    expect(retiredCatalogIds.retiredIds).toHaveLength(18);
    expect(new Set(retiredCatalogIds.retiredIds).size).toBe(retiredCatalogIds.retiredIds.length);
    expect(ids.filter(id => retiredCatalogIds.retiredIds.includes(id))).toEqual([]);
    expect(retiredCatalogIds.baselineIds).toHaveLength(196);
    expect(new Set(retiredCatalogIds.baselineIds).size).toBe(retiredCatalogIds.baselineIds.length);
    expect([...ids, ...retiredCatalogIds.retiredIds].sort()).toEqual([...retiredCatalogIds.baselineIds].sort());
    expect(ids).toContain('self_implement');
  });
});
