import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { selectAffectedRootNames } from './typecheck-ratchet.js';

test('changed TypeScript file, direct and transitive importers become roots; unrelated roots stay out', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'typecheck-affected-roots-'));
  try {
    mkdirSync(join(cwd, 'src'));
    writeFileSync(join(cwd, 'src/leaf.ts'), 'export const value = 1;\n');
    writeFileSync(join(cwd, 'src/direct.ts'), "import { value } from './leaf.js'; export const direct = value;\n");
    writeFileSync(join(cwd, 'src/entry.ts'), "import { direct } from './direct.js'; export const entry = direct;\n");
    writeFileSync(join(cwd, 'src/side.ts'), 'export const side = 2;\n');
    const roots = ['src/side.ts', 'src/entry.ts', 'src/leaf.ts', 'src/direct.ts'];
    expect(selectAffectedRootNames(roots, new Set(['./src/leaf.ts']), { moduleResolution: ts.ModuleResolutionKind.NodeNext, module: ts.ModuleKind.NodeNext }, ts.sys, cwd))
      .toEqual(['src/entry.ts', 'src/leaf.ts', 'src/direct.ts']);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('TSX importers and re-export barrels follow compiler path aliases', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'typecheck-affected-alias-'));
  try {
    mkdirSync(join(cwd, 'src'));
    writeFileSync(join(cwd, 'src/model.ts'), 'export type Model = { value: number };\n');
    writeFileSync(join(cwd, 'src/barrel.ts'), "export type { Model } from '@src/model';\n");
    writeFileSync(join(cwd, 'src/view.tsx'), "import type { Model } from '@src/barrel'; export const view = {} as Model;\n");
    writeFileSync(join(cwd, 'src/unrelated.ts'), 'export const unrelated = 1;\n');
    const roots = ['src/view.tsx', 'src/unrelated.ts', 'src/barrel.ts', 'src/model.ts'];
    expect(selectAffectedRootNames(roots, new Set(['src/model.ts']), {
      baseUrl: cwd, paths: { '@src/*': ['src/*'] }, moduleResolution: ts.ModuleResolutionKind.Node10,
    }, ts.sys, cwd)).toEqual(['src/view.tsx', 'src/barrel.ts', 'src/model.ts']);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('a changed dependency outside rootNames selects its importers, not other roots', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'typecheck-affected-dependency-'));
  try {
    mkdirSync(join(cwd, 'src'));
    writeFileSync(join(cwd, 'src/shared.ts'), 'export const shared = 1;\n');
    writeFileSync(join(cwd, 'src/bridge.ts'), "export { shared } from './shared';\n");
    writeFileSync(join(cwd, 'src/consumer.ts'), "import { shared } from './bridge'; export const value = shared;\n");
    writeFileSync(join(cwd, 'src/other.ts'), 'export const other = 0;\n');
    expect(selectAffectedRootNames(['src/consumer.ts', 'src/other.ts'], new Set(['src/shared.ts']), {
      moduleResolution: ts.ModuleResolutionKind.Node10,
    }, ts.sys, cwd)).toEqual(['src/consumer.ts']);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('a deleted TypeScript dependency falls back to all roots rather than missing its importer', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'typecheck-affected-deleted-'));
  try {
    mkdirSync(join(cwd, 'src'));
    writeFileSync(join(cwd, 'src/importer.ts'), "import { value } from './deleted.js'; export const result = value;\n");
    writeFileSync(join(cwd, 'src/other.ts'), 'export const other = 1;\n');
    const roots = ['src/importer.ts', 'src/other.ts'];
    expect(selectAffectedRootNames(roots, new Set(['src/deleted.ts']), {
      module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    }, ts.sys, cwd)).toEqual(roots);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('an unreadable root cannot silently masquerade as having no importers', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'typecheck-affected-unreadable-'));
  try {
    expect(() => selectAffectedRootNames(['missing.ts'], new Set(['changed.ts']), {}, ts.sys, cwd))
      .toThrow('Cannot read typecheck root dependency');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('only TypeScript changes select roots, and cycles do not expand to unrelated roots', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'typecheck-affected-cycle-'));
  try {
    writeFileSync(join(cwd, 'a.ts'), "import './b.js';\n");
    writeFileSync(join(cwd, 'b.ts'), "import './a.js';\n");
    writeFileSync(join(cwd, 'other.tsx'), 'export const other = 1;\n');
    const roots = ['a.ts', 'b.ts', 'other.tsx'];
    const options = { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext };
    expect(selectAffectedRootNames(roots, new Set(['b.ts', 'README.md']), options, ts.sys, cwd)).toEqual(['a.ts', 'b.ts']);
    expect(selectAffectedRootNames(roots, new Set(['README.md']), options, ts.sys, cwd)).toEqual([]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('no changed TypeScript file selects no roots without reading the dependency graph', () => {
  const reads: string[] = [];
  const host: ts.ModuleResolutionHost = { fileExists: () => true, readFile: (file) => { reads.push(file); return ''; } };
  expect(selectAffectedRootNames(['src/a.ts', 'src/b.ts'], new Set(['README.md', 'docs/x.json']), {}, host, '/repo')).toEqual([]);
  expect(selectAffectedRootNames(['src/a.ts'], new Set(), {}, host, '/repo')).toEqual([]);
  expect(reads).toEqual([]);
});
