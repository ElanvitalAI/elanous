// 🩸 2026-09-25 — `pr land` 의 격리 게이트가 «착지하는 트리»가 아니라 bin 이 있는 트리(pilot)를 검사했다.
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportImportBlock, runPrLandExportImportCheck, runPrLandIsolationGate } from './pr-cli.js';

function repo(withHardcode: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'iso-gate-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'scripts', 'isolation-hardcode-baseline.txt'), '');
  writeFileSync(join(dir, 'src', 'a.ts'), withHardcode
    ? "import { homedir } from 'node:os';\nimport { join } from 'node:path';\nexport const p = join(homedir(), '.elanous', 'auth.json');\n"
    : "export const p = 1;\n");
  spawnSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

const quiet = { log: () => {}, error: () => {} };

test('the gate judges the tree being landed (cwd), not the tree the CLI binary lives in', () => {
  expect(runPrLandIsolationGate(quiet, repo(true))).toBe(false);
  expect(runPrLandIsolationGate(quiet, repo(false))).toBe(true);
});

test('a subdirectory resolves to the repository top level', () => {
  const dir = repo(true);
  expect(runPrLandIsolationGate(quiet, join(dir, 'src'))).toBe(false);
});

test('the export-import gate judges the tree being landed (cwd), not the tree the CLI binary lives in', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'import-gate-cwd-'));
  mkdirSync(join(dir, 'node_modules/typescript'), { recursive: true });
  writeFileSync(join(dir, 'node_modules/typescript/package.json'), '{"name":"typescript","version":"0.0.0","main":"index.js"}\n');
  writeFileSync(join(dir, 'node_modules/typescript/index.js'), 'module.exports = {};\n');
  mkdirSync(join(dir, 'src/decisions'), { recursive: true });
  mkdirSync(join(dir, 'src/directives'), { recursive: true });
  mkdirSync(join(dir, 'release'), { recursive: true });
  writeFileSync(join(dir, 'release/public-export.yaml'), 'include: ["src/**"]\nexclude: ["src/directives/directive-index*"]\n');
  writeFileSync(join(dir, 'src/directives/directive-index.ts'), 'export const index = 1;\n');
  writeFileSync(join(dir, 'src/decisions/proact-meter.ts'), "import { index } from '../directives/directive-index.js';\nexport const meter = index;\n");
  spawnSync('git', ['init', '-q'], { cwd: dir });
  spawnSync('git', ['add', '-A'], { cwd: dir });
  const errors: string[] = [];
  const out = { log: () => {}, error: (line: string) => errors.push(line) };
  expect(await exportImportBlock(
    ['src/decisions/proact-meter.ts'],
    () => runPrLandExportImportCheck(['src/decisions/proact-meter.ts'], join(dir, 'src')),
    out,
  )).toBe(false);
  expect(errors.join('\n')).toContain('src/decisions/proact-meter.ts:1 → src/directives/directive-index.ts');
});
