import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dashboardMatches, dashboardSourceLocations, readDashboardSources, type DashboardSource } from './helpers/dashboard-source.js';

const MOUNT_IMPORT = /import\s*{[^}]*\bmountScenarioIntoTarget\b[^}]*}\s*from ['"](?:\.\.\/)+tool-runtime\/scenario-target-mount\.js['"]/;
const MOUNT_CALL = /\(\s*deps\.mountIntoTarget\s*\?\?\s*mountScenarioIntoTarget\s*\)\s*\(/;

function sharedMountSources(sources: readonly DashboardSource[]): DashboardSource[] {
  // This is a same-module source contract; proving boot reachability belongs to the later import-graph stage.
  return sources.filter(({ text }) => MOUNT_IMPORT.test(text) && MOUNT_CALL.test(text));
}

function text(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

describe('ui foundation · R9.U-5(b) target boundary source truth', () => {
  test('target mount helper locks the supported mount target roster and explicit unsupported reasons', () => {
    const src = text('../src/tool-runtime/scenario-target-mount.ts');
    expect(src).toContain("export const RUN_SCENARIO_MOUNT_TARGET_KINDS = [");
    expect(src).toContain("'window'");
    expect(src).toContain("'pane'");
    expect(src).toContain("'modal'");
    expect(src).toContain("'widget'");
    expect(src).toContain('not a mount container');
    expect(src).toContain('transient and not a scenario mount destination');
  });

  test('dashboard uses the shared target mount helper instead of an ad-hoc target-kind switch', () => {
    const sources = readDashboardSources();
    const shared = sharedMountSources(sources);
    expect(shared.length, `Missing shared target mount import and default call in the same file: ${dashboardSourceLocations(sources)}`).toBeGreaterThan(0);
    expect(dashboardMatches(MOUNT_IMPORT, shared).length,
      `Missing shared mount import in ${dashboardSourceLocations(sources)}`).toBeGreaterThan(0);
    expect(dashboardMatches(/mountScenarioIntoTarget/, shared).length,
      `Missing shared mount identifier in ${dashboardSourceLocations(sources)}`).toBeGreaterThan(0);
    expect(dashboardMatches(MOUNT_CALL, shared).length,
      `Missing shared mount call in ${dashboardSourceLocations(sources)}`).toBeGreaterThan(0);
    const unsupported = dashboardMatches(/is not supported by the dashboard mount path yet/, sources);
    expect(unsupported, `Unexpected ad-hoc branch at ${unsupported.map(({ path, line }) => `${path}:${line}`).join(', ')}`).toEqual([]);
  });

  test('does not combine an unused mount import with another module’s mount call', () => {
    const root = mkdtempSync(join(tmpdir(), 'dashboard-mount-contract-'));
    const dir = join(root, 'src/dashboard');
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(join(dir, 'index.ts'), 'export {};\n');
      writeFileSync(join(dir, 'unused.ts'), "import { mountScenarioIntoTarget } from '../tool-runtime/scenario-target-mount.js';\n");
      writeFileSync(join(dir, 'other.ts'), '(deps.mountIntoTarget ?? mountScenarioIntoTarget)(widgets, target, deps);\n');
      expect(sharedMountSources(readDashboardSources(dir))).toEqual([]);
      writeFileSync(join(dir, 'other.ts'), "import { mountScenarioIntoTarget } from '../tool-runtime/scenario-target-mount.js';\n(deps.mountIntoTarget ?? mountScenarioIntoTarget)(widgets, target, deps);\n");
      expect(sharedMountSources(readDashboardSources(dir))).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('run scenario runtime spec names the supported target kinds explicitly', () => {
    const src = text('../src/tool-runtime/scenario-runtimes.ts');
    expect(src).toContain("import { RUN_SCENARIO_MOUNT_TARGET_KINDS } from './scenario-target-mount.js';");
    expect(src).toContain('Supported mount destinations are ');
    expect(src).toContain('input/popover/inline/bg return explicit unsupported-target errors');
  });
});
