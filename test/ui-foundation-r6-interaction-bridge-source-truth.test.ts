import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { resolve } from 'path';

function read(rel: string): string {
  return readFileSync(resolve(import.meta.dir, '..', rel), 'utf8');
}

describe('ui foundation · R6 interaction bridge source truth', () => {
  test('dashboard virtual windows exposes separate selector and context-menu callbacks', () => {
    // 2026-07-07 · dashboard decomposition: src/dashboard-virtual-windows.ts
    // moved to src/dashboard/windowing/virtual-windows.ts.
    const src = read('src/dashboard/windowing/virtual-windows.ts');
    expect(src).toContain('onShowSelector?:');
    expect(src).toContain('onShowContextMenu?:');
  });

  test('dashboard boots the remaining context-menu provider registry', () => {
    const ctxMenuBoot = read('src/dashboard/context-menu-provider-boot.ts');
    expect(ctxMenuBoot).toContain('registerVirtualWindowContextMenus(providers, {');

    const dashboard = read('src/dashboard/index.ts');
    expect(dashboard).toContain('const ctxMenuProviders = bootDashboardContextMenuProviders({');
  });
});
