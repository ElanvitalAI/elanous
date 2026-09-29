import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dashboardMatches, dashboardSourceLocations, readDashboardSources, type DashboardSource } from './helpers/dashboard-source.js';

const MODAL_IMPORT = /import\s*{[^}]*\bmountScenarioIntoModal\b[^}]*}\s*from ['"](?:\.\.\/)+tool-runtime\/scenario-modal-mount\.js['"]/;
const WIDGET_IMPORT = /import\s*{[^}]*\bmountScenarioIntoWidget\b[^}]*}\s*from ['"](?:\.\.\/)+tool-runtime\/scenario-widget-mount\.js['"]/;
const MODAL_CALL = /\(\s*deps\.mountIntoModal\s*\?\?\s*mountScenarioIntoModal\s*\)\s*\(/;
const WIDGET_CALL = /\(\s*deps\.mountIntoWidget\s*\?\?\s*mountScenarioIntoWidget\s*\)\s*\(/;

// #21723: dashboard wires modal/widget mount helpers separately; window/pane are unsupported.
function sharedMountSources(sources: readonly DashboardSource[]): DashboardSource[] {
  // Both supported mounts must be wired in the same module, not assembled from unrelated imports.
  return sources.filter(({ text }) => MODAL_IMPORT.test(text) && WIDGET_IMPORT.test(text)
    && MODAL_CALL.test(text) && WIDGET_CALL.test(text));
}

function text(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

describe('ui foundation · R9.U-5(b) target boundary source truth', () => {
  test('target mount helper locks the supported mount target roster and explicit unsupported reasons', () => {
    const src = text('../src/tool-runtime/scenario-target-mount.ts');
    expect(src).toContain("export const RUN_SCENARIO_MOUNT_TARGET_KINDS = [");
    expect(src.match(/RUN_SCENARIO_MOUNT_TARGET_KINDS = \[([^\]]+)\]/)?.[1]?.match(/'[^']+'/g))
      .toEqual(["'modal'", "'widget'"]);
    expect(src).toContain("case 'window':");
    expect(src).toContain("case 'pane':");
    expect(src).toContain('not a mount container');
    expect(src).toContain('transient and not a scenario mount destination');
  });

  test('dashboard uses the shared target mount helper instead of an ad-hoc target-kind switch', () => {
    const sources = readDashboardSources();
    const shared = sharedMountSources(sources);
    expect(shared.length, `Missing shared target mount import and default call in the same file: ${dashboardSourceLocations(sources)}`).toBeGreaterThan(0);
    for (const pattern of [MODAL_IMPORT, WIDGET_IMPORT, MODAL_CALL, WIDGET_CALL]) {
      expect(dashboardMatches(pattern, shared).length,
        `Missing supported mount wiring in ${dashboardSourceLocations(sources)}`).toBeGreaterThan(0);
    }
    expect(dashboardMatches(/unsupportedRunScenarioTargetError\(target\)/, shared).length).toBeGreaterThan(0);
    const unsupported = dashboardMatches(/is not supported by the dashboard mount path yet/, sources);
    expect(unsupported, `Unexpected ad-hoc branch at ${unsupported.map(({ path, line }) => `${path}:${line}`).join(', ')}`).toEqual([]);
  });

  test('does not combine an unused mount import with another module’s mount call', () => {
    const root = mkdtempSync(join(tmpdir(), 'dashboard-mount-contract-'));
    const dir = join(root, 'src/dashboard');
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(join(dir, 'index.ts'), 'export {};\n');
      writeFileSync(join(dir, 'unused.ts'), "import { mountScenarioIntoModal } from '../tool-runtime/scenario-modal-mount.js';\nimport { mountScenarioIntoWidget } from '../tool-runtime/scenario-widget-mount.js';\n");
      writeFileSync(join(dir, 'other.ts'), '(deps.mountIntoModal ?? mountScenarioIntoModal)(widgets, target.modalId, deps);\n(deps.mountIntoWidget ?? mountScenarioIntoWidget)(widgets, target.widgetId, deps);\n');
      expect(sharedMountSources(readDashboardSources(dir))).toEqual([]);
      writeFileSync(join(dir, 'other.ts'), "import { mountScenarioIntoModal } from '../tool-runtime/scenario-modal-mount.js';\nimport { mountScenarioIntoWidget } from '../tool-runtime/scenario-widget-mount.js';\n(deps.mountIntoModal ?? mountScenarioIntoModal)(widgets, target.modalId, deps);\n(deps.mountIntoWidget ?? mountScenarioIntoWidget)(widgets, target.widgetId, deps);\n");
      expect(sharedMountSources(readDashboardSources(dir))).toHaveLength(1);
      // Removing either mount call breaks the shared default path, not just its import.
      writeFileSync(join(dir, 'other.ts'), "import { mountScenarioIntoModal } from '../tool-runtime/scenario-modal-mount.js';\nimport { mountScenarioIntoWidget } from '../tool-runtime/scenario-widget-mount.js';\n(deps.mountIntoModal ?? mountScenarioIntoModal)(widgets, target.modalId, deps);\n");
      expect(sharedMountSources(readDashboardSources(dir))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('run scenario runtime spec names the supported target kinds explicitly', () => {
    const src = text('../src/tool-runtime/scenario-runtimes.ts');
    expect(src).toMatch(/import\s*\{[^}]*\bRUN_SCENARIO_MOUNT_TARGET_KINDS\b[^}]*\}\s*from ['"]\.\/scenario-target-mount\.js['"]/);
    expect(src).toContain('Supported mount destinations are ');
    expect(src).toContain('input/popover/inline/bg return explicit unsupported-target errors');
  });
});
