import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dashboardMatches, dashboardSourceText, readDashboardSources, readTuiSources, TUI_ENTRY_PATH, tuiSourceFileWith, tuiSourceText } from './helpers/dashboard-source.js';

describe('dashboard source directory reader', () => {
  test('preserves match count when a string moves from index.ts to moved.ts, reporting its file and line', () => {
    const root = mkdtempSync(join(tmpdir(), 'dashboard-source-'));
    const dir = join(root, 'src/dashboard');
    mkdirSync(dir, { recursive: true });
    try {
      const index = join(dir, 'index.ts');
      const moved = join(dir, 'moved.ts');
      writeFileSync(index, 'const marker = "dashboard.input.visibility";\n');
      writeFileSync(moved, 'export {};\n');
      const before = dashboardMatches(/dashboard\.input\.visibility/, readDashboardSources(dir));
      expect(before).toHaveLength(1);
      expect(before[0]).toMatchObject({ path: expect.stringContaining('index.ts'), line: 1 });

      writeFileSync(index, 'export {};\n');
      writeFileSync(moved, '\nconst marker = "dashboard.input.visibility";\n');
      const after = dashboardMatches(/dashboard\.input\.visibility/, readDashboardSources(dir));
      expect(after).toHaveLength(before.length);
      expect(after[0]).toMatchObject({ path: expect.stringContaining('moved.ts'), line: 2 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('reads nested sources without including test files or matching across file boundaries', () => {
    const root = mkdtempSync(join(tmpdir(), 'dashboard-source-'));
    const dir = join(root, 'src/dashboard');
    mkdirSync(join(dir, 'nested'), { recursive: true });
    try {
      writeFileSync(join(dir, 'index.ts'), 'first');
      writeFileSync(join(dir, 'nested/moved.ts'), 'second');
      writeFileSync(join(dir, 'nested/ignored.test.ts'), 'second');
      const sources = readDashboardSources(dir);
      expect(sources).toHaveLength(2);
      expect(dashboardSourceText(sources)).toContain('first\nsecond');
      expect(dashboardMatches(/second/, sources)).toHaveLength(1);
      expect(dashboardMatches(/first[\s\S]*second/, sources)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('TUI source bundle reader (src/dashboard/** ⊕ src/tui/**)', () => {
  function fixture(): string {
    const root = mkdtempSync(join(tmpdir(), 'tui-source-'));
    mkdirSync(join(root, 'src/dashboard/a-first'), { recursive: true });
    mkdirSync(join(root, 'src/tui/input'), { recursive: true });
    writeFileSync(join(root, 'src/dashboard/a-first/early.ts'), 'export const early = "openFinderPicker(";\n');
    writeFileSync(join(root, TUI_ENTRY_PATH), 'export function openFinderPicker() {}\n');
    writeFileSync(join(root, 'src/dashboard/index.test.ts'), 'export const fromTest = "testOnlyMarker";\n');
    writeFileSync(join(root, 'src/tui/input/pickers.ts'), 'export function openSshPicker() {}\n');
    return root;
  }

  test('reads both directories, puts the entry file first and skips test files', () => {
    const root = fixture();
    try {
      const sources = readTuiSources(root);
      expect(sources.map(({ path }) => path)).toEqual([TUI_ENTRY_PATH, 'src/dashboard/a-first/early.ts', 'src/tui/input/pickers.ts']);
      const text = tuiSourceText(root);
      expect(text).toContain('openSshPicker');
      expect(text).not.toContain('testOnlyMarker');
      expect(text.indexOf('openFinderPicker(')).toBeLessThan(text.indexOf('export const early'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('finds the file holding an identifier wherever it lives, and throws when it is gone', () => {
    const root = fixture();
    try {
      expect(tuiSourceFileWith('openFinderPicker(', root).path).toBe(TUI_ENTRY_PATH);
      expect(tuiSourceFileWith(/function openSshPicker\(/g, root).path).toBe('src/tui/input/pickers.ts');
      expect(() => tuiSourceFileWith('openTransferPicker', root)).toThrow('openTransferPicker');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
