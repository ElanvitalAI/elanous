import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dashboardMatches, dashboardSourceText, readDashboardSources } from './helpers/dashboard-source.js';

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
