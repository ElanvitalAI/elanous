import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  registerDashboardGlobalKeys,
  type DashboardGlobalKeyRegistration,
} from '../src/dashboard/index.js';
import { buildUserConfig, saveUserConfig } from '../src/user-config.js';

function writeConfig(dashboard: Record<string, unknown>): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dashboard-vw-switch-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({ dashboard }), 'utf-8');
  return { dir, path };
}

function registeredGlobalKeys(enableSupplementalGlobalKeys: boolean): string[] {
  const bindings: DashboardGlobalKeyRegistration[] = [];
  registerDashboardGlobalKeys({
    enableSupplementalGlobalKeys,
    register: (binding) => { bindings.push(binding); },
    openSurfaceCatalog: () => {},
  });
  return bindings.map((binding) => binding.id);
}

describe('dashboard global key config', () => {
  test('defaults both settings false for absent, undefined, and invalid values', () => {
    for (const value of [undefined, 'true', 1, null]) {
      const dashboard = value === undefined
        ? {}
        : { enableVirtualWindowSwitchKeys: value, enableSupplementalGlobalKeys: value };
      const { dir, path } = writeConfig(dashboard);
      const config = buildUserConfig(path).dashboard;
      expect(config.enableVirtualWindowSwitchKeys).toBe(false);
      expect(config.enableSupplementalGlobalKeys).toBe(false);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('keeps literal true through normalization and serialization without changing either setting', () => {
    const { dir, path } = writeConfig({ enableVirtualWindowSwitchKeys: true, enableSupplementalGlobalKeys: true });
    const config = buildUserConfig(path);
    expect(config.dashboard.enableVirtualWindowSwitchKeys).toBe(true);
    expect(config.dashboard.enableSupplementalGlobalKeys).toBe(true);

    const output = join(dir, 'saved.json');
    saveUserConfig(config, output);
    const dashboard = JSON.parse(readFileSync(output, 'utf-8')).dashboard;
    expect(dashboard.enableVirtualWindowSwitchKeys).toBe(true);
    expect(dashboard.enableSupplementalGlobalKeys).toBe(true);
    const restored = buildUserConfig(output).dashboard;
    expect(restored.enableVirtualWindowSwitchKeys).toBe(true);
    expect(restored.enableSupplementalGlobalKeys).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test('registration leaves retired VW chords unbound with either config setting', () => {
    const disabled = registeredGlobalKeys(false);
    const enabled = registeredGlobalKeys(true);

    expect(disabled).toEqual([]);
    expect(enabled).toEqual(['dashboard:open-surface-catalog']);
  });

  test('keeps virtual-window switch configuration independent from supplemental keys', () => {
    const { dir, path } = writeConfig({ enableVirtualWindowSwitchKeys: true, enableSupplementalGlobalKeys: false });
    const dashboard = buildUserConfig(path).dashboard;
    expect(dashboard.enableVirtualWindowSwitchKeys).toBe(true);
    expect(dashboard.enableSupplementalGlobalKeys).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});
