import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { resolve } from 'path';

function read(rel: string): string {
  return readFileSync(resolve(import.meta.dir, '..', rel), 'utf8');
}

describe('ui foundation · R6 interaction bridge source truth', () => {
  test('dashboard boots the remaining context-menu provider registry', () => {
    const ctxMenuBoot = read('src/dashboard/context-menu-provider-boot.ts');
    expect(ctxMenuBoot).not.toContain('registerVirtualWindowContextMenus');
    for (const provider of ['registerBrowserContextMenus', 'registerScratchContextMenus', 'registerDashboardPaneTitleContextMenus', 'registerDebugContextMenus']) {
      expect(ctxMenuBoot).toContain(`${provider}(providers, {`);
    }

    const dashboard = read('src/dashboard/index.ts');
    expect(dashboard).toContain('const ctxMenuProviders = bootDashboardContextMenuProviders({');
  });
});
