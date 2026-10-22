import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

test('every src/tui TypeScript file stays below the 4,000 line limit', () => {
  const root = import.meta.dir;
  const files: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(path);
    }
  };
  visit(root);
  const oversized = files.filter((path) => readFileSync(path, 'utf8').split('\n').length > 4_000);
  expect(oversized).toEqual([]);
});

test('next entry imports no dashboard module and legacy imports do not grow', () => {
  const root = import.meta.dir;
  const files: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) files.push(path);
    }
  };
  visit(root);
  const dashboardImports = files.flatMap((path) => {
    const source = readFileSync(path, 'utf8');
    return [...source.matchAll(/(?:from\s*|import\s*\()['"]([^'"]*dashboard\/[^'"]+)['"]/g)]
      .map((match) => `${path.slice(root.length + 1)}:${match[1]}`);
  }).sort();
  // These are pre-existing legacy TUI references. The next entry's closure has none.
  expect(dashboardImports).toEqual([
    'input/pickers.ts:../../dashboard/finder-feedback-runtime.js',
    'input/pickers.ts:../../dashboard/modals/preview.js',
    'input/pickers.ts:../../dashboard/transfer-feedback-runtime.js',
    'slash/mission.ts:../../dashboard/slash-runtime/registry.js',
    'slash/term.ts:../../dashboard/input/terminal-modal-router.js',
    'slash/term.ts:../../dashboard/slash-runtime/registry.js',
    'slash/term.ts:../../dashboard/term-slash-runtime.js',
  ]);
  for (const path of ['entry.ts', 'input/composer.ts', 'chat/log-view.ts']) {
    expect(readFileSync(join(root, path), 'utf8')).not.toMatch(/(?:from\s*|import\s*\()['"][^'"]*dashboard\//);
  }
});
