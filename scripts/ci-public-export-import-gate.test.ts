import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportImportCheck, runPublicExportImportGate } from './ci-public-export-import-gate.js';

/** A tiny tracked repo whose public manifest includes src/** and excludes the directive index. */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'export-import-gate-'));
  // public-export.ts imports typescript at load. The selectors this gate calls do not use it.
  mkdirSync(join(root, 'node_modules/typescript'), { recursive: true });
  writeFileSync(join(root, 'node_modules/typescript/package.json'), '{"name":"typescript","version":"0.0.0","main":"index.js"}\n');
  writeFileSync(join(root, 'node_modules/typescript/index.js'), 'module.exports = {};\n');
  mkdirSync(join(root, 'src/decisions'), { recursive: true });
  mkdirSync(join(root, 'src/directives'), { recursive: true });
  mkdirSync(join(root, 'release'), { recursive: true });
  writeFileSync(join(root, 'release/public-export.yaml'), [
    'include:',
    '  - src/**',
    'exclude:',
    '  - src/directives/directive-index*',
    '',
  ].join('\n'));
  writeFileSync(join(root, 'src/directives/directive-index.ts'), 'export const index = 1;\n');
  writeFileSync(join(root, 'src/directives/kept.ts'), 'export const kept = 1;\n');
  writeFileSync(join(root, 'src/decisions/proact-meter.ts'), "import { index } from '../directives/directive-index.js';\nexport const meter = index;\n");
  const git = spawnSync('git', ['init', '-q'], { cwd: root });
  expect(git.status).toBe(0);
  const add = spawnSync('git', ['add', '-A'], { cwd: root, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  expect(add.status).toBe(0);
  return root;
}

test('an included file that statically imports an excluded module fails and names path:line → target', async () => {
  const root = fixture();
  try {
    const result = await exportImportCheck(['src/decisions/proact-meter.ts'], root);
    expect(result.measured).toBe(true);
    expect(result.hits).toEqual([{ file: 'src/decisions/proact-meter.ts', line: 1, target: 'src/directives/directive-index.ts' }]);
    const errors: string[] = [];
    const code = await runPublicExportImportGate({
      args: ['--changed-files', 'src/decisions/proact-meter.ts'],
      cwd: root,
      log: () => {},
      error: (line) => errors.push(line),
    });
    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('src/decisions/proact-meter.ts:1 → src/directives/directive-index.ts');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('removing that import passes, and importing a module that is not excluded passes', async () => {
  const root = fixture();
  try {
    writeFileSync(join(root, 'src/decisions/proact-meter.ts'), 'export const meter = 1;\n');
    expect(await exportImportCheck(['src/decisions/proact-meter.ts'], root)).toMatchObject({ measured: true, hits: [] });
    expect(await runPublicExportImportGate({ args: ['--changed-files', 'src/decisions/proact-meter.ts'], cwd: root, log: () => {}, error: () => {} })).toBe(0);

    writeFileSync(join(root, 'src/decisions/proact-meter.ts'), "import { kept } from '../directives/kept.js';\nexport const meter = kept;\n");
    const kept = await exportImportCheck(['src/decisions/proact-meter.ts'], root);
    expect(kept.hits).toEqual([]);
    expect(await runPublicExportImportGate({ args: ['--changed-files', 'src/decisions/proact-meter.ts'], cwd: root, log: () => {}, error: () => {} })).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a non-literal specifier is counted as unseen and does not fail the gate by itself', async () => {
  const root = fixture();
  try {
    writeFileSync(join(root, 'src/decisions/proact-meter.ts'), "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);\nconst name = 'directive-index';\nrequire('../directives/' + name);\nexport const meter = 1;\n");
    const logs: string[] = [];
    const result = await exportImportCheck(['src/decisions/proact-meter.ts'], root);
    expect(result.hits).toEqual([]);
    expect(result.unseen).toBeGreaterThan(0);
    expect(await runPublicExportImportGate({
      args: ['--changed-files', 'src/decisions/proact-meter.ts'],
      cwd: root,
      log: (line) => logs.push(line),
      error: () => {},
    })).toBe(0);
    expect(logs.join('\n')).toContain('못 봄');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('export from and a dynamic import() of an excluded module are hits; an excluded importer is not scanned', async () => {
  const root = fixture();
  try {
    writeFileSync(join(root, 'src/decisions/proact-meter.ts'), "export { index } from '../directives/directive-index';\nexport const load = () => import('../directives/directive-index.ts');\n");
    const result = await exportImportCheck(['src/decisions/proact-meter.ts'], root);
    expect(result.hits.map((hit) => `${hit.file}:${hit.line} → ${hit.target}`)).toEqual([
      'src/decisions/proact-meter.ts:1 → src/directives/directive-index.ts',
      'src/decisions/proact-meter.ts:2 → src/directives/directive-index.ts',
    ]);
    expect((await exportImportCheck(['src/directives/directive-index.ts'], root)).hits).toEqual([]);
    expect(await runPublicExportImportGate({ args: ['--changed-files'], cwd: root, log: () => {}, error: () => {} })).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an excluded module that the export replaces is present in the export, so importing it is not a hit', async () => {
  const root = fixture();
  try {
    // Same shape as apps/pwa/.../sidebar-nav-private.ts: excluded from the private tree, written by `replace`.
    writeFileSync(join(root, 'release/public-export.yaml'), [
      'include:',
      '  - src/**',
      'exclude:',
      '  - src/directives/directive-index*',
      'replace:',
      '  src/directives/directive-index.ts: release/public/directive-index.ts',
      '',
    ].join('\n'));
    expect(await exportImportCheck(['src/decisions/proact-meter.ts'], root)).toMatchObject({ measured: true, hits: [] });
    expect(await runPublicExportImportGate({ args: ['--changed-files', 'src/decisions/proact-meter.ts'], cwd: root, log: () => {}, error: () => {} })).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a replaced private original is not scanned as an importer, even if it imports an excluded module', async () => {
  const root = fixture();
  try {
    writeFileSync(join(root, 'release/public-export.yaml'), [
      'include:',
      '  - src/**',
      'exclude:',
      '  - src/directives/directive-index*',
      '  - src/decisions/proact-meter.ts',
      'replace:',
      '  src/decisions/proact-meter.ts: release/public/proact-meter.ts',
      '',
    ].join('\n'));
    // proact-meter.ts (excluded, replaced) still imports the excluded directive index — the export ships the replacement.
    expect(await exportImportCheck(['src/decisions/proact-meter.ts'], root)).toMatchObject({ measured: true, hits: [] });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
