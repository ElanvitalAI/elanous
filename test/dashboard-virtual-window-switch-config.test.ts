import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildUserConfig, saveUserConfig } from '../src/user-config.js';

function writeConfig(dashboard: Record<string, unknown>): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dashboard-vw-switch-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({ dashboard }), 'utf-8');
  return { dir, path };
}

describe('dashboard virtual window key config', () => {
  test('defaults false for absent, undefined, and invalid values', () => {
    for (const value of [undefined, 'true', 1, null]) {
      const dashboard = value === undefined
        ? {}
        : { enableVirtualWindowSwitchKeys: value };
      const { dir, path } = writeConfig(dashboard);
      const config = buildUserConfig(path).dashboard;
      expect(config.enableVirtualWindowSwitchKeys).toBe(false);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('normalizes retired virtual-window key setting to false', () => {
    const { dir, path } = writeConfig({ enableVirtualWindowSwitchKeys: true });
    const config = buildUserConfig(path);
    expect(config.dashboard.enableVirtualWindowSwitchKeys).toBe(false);

    const output = join(dir, 'saved.json');
    saveUserConfig(config, output);
    const dashboard = JSON.parse(readFileSync(output, 'utf-8')).dashboard;
    expect(dashboard?.enableVirtualWindowSwitchKeys).toBeUndefined();
    const restored = buildUserConfig(output).dashboard;
    expect(restored.enableVirtualWindowSwitchKeys).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

});
