import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { environmentContract, environmentSummary, missingMethodHint, readEnvironmentReceipt, unavailableImportHint, unavailableImports,
  writeEnvironmentReceipt, type DeploymentEnvironment } from './deployment-environment.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const measured: DeploymentEnvironment = {
  runtime: { command: 'bun', version: '1.4.2', platform: 'darwin' },
  builtinModules: ['bun:sqlite', 'node:fs', 'node:path'], testModules: ['bun:test'], storageModules: ['bun:sqlite'],
  apiSurfaces: [{ module: 'bun:sqlite', exports: ['Database'], classes: [{ name: 'Database', methods: ['exec', 'query', 'run'] }] }],
  nodeModulesPresent: false, installedPackages: [], packageInstallAvailable: false, network: 'off',
  writableArtifactRoot: true, writableTempRoot: true, portBindingAvailable: false,
  sandbox: 'darwin-private-netoff-envempty',
};

test('one measured environment drives both the deployment prompt and a file/line import repair hint', () => {
  const contract = environmentContract(measured);
  expect(contract).toContain('runtime bun 1.4.2');
  expect(contract).toContain('available storage modules: bun:sqlite');
  expect(contract).toContain('package installation unavailable');
  expect(contract).toContain('exports fetch(request) or default {fetch}');
  expect(contract).toContain('Tests run with bun test');
  expect(contract).toContain('Database.prototype methods: exec, query, run');
  expect(missingMethodHint('TypeError: db.pragma is not a function', measured)).toContain('absent from measured storage API surfaces: pragma');
  expect(missingMethodHint('TypeError: db.pragma is not a function', measured)).toContain('Database.prototype methods: exec, query, run');
  const files = [{ path: 'backend/db.ts', content: [
    "import { readFileSync } from 'node:fs';",
    "import { Database } from 'better-sqlite3';",
    "import { helper } from './helper.ts';",
  ].join('\n') }, { path: 'frontend/index.html', content: '<script src="https://example.invalid/x.js"></script>' }];
  const issues = unavailableImports(files, measured);
  expect(issues).toEqual([{ path: 'backend/db.ts', line: 2, specifier: 'better-sqlite3' }]);
  expect(unavailableImportHint(issues, measured)).toContain('backend/db.ts:2 imports better-sqlite3');
  expect(unavailableImportHint(issues, measured)).toContain('bun:sqlite');
  expect(environmentSummary(measured)).toContain('포트 불가');
  expect(unavailableImports([{ path: 'backend/db.ts', content: [
    '// better-sqlite3 is unavailable',
    "const db = require('better-sqlite3');",
    "await import('other-package');",
  ].join('\n') }], measured)).toEqual([
    { path: 'backend/db.ts', line: 2, specifier: 'better-sqlite3' },
    { path: 'backend/db.ts', line: 3, specifier: 'other-package' },
  ]);
  expect(unavailableImports([{ path: 'backend/late.ts', content: [
    "await import('missing', { with: { type: 'json' } });",
    'const dependency = require(packageName);',
  ].join('\n') }], measured)).toEqual([
    { path: 'backend/late.ts', line: 1, specifier: 'missing' },
    { path: 'backend/late.ts', line: 2, specifier: '<dynamic-module>' },
  ]);
  expect(unavailableImports([{ path: 'backend/fs.ts', content: "import { readFileSync } from 'node:fs';" }],
    { ...measured, builtinModules: ['fs'] })).toEqual([{ path: 'backend/fs.ts', line: 1, specifier: 'node:fs' }]);
  expect(unavailableImports([{ path: 'backend/fs.ts', content: "import { readFileSync } from 'fs';" }],
    { ...measured, builtinModules: ['node:fs'] })).toEqual([{ path: 'backend/fs.ts', line: 1, specifier: 'fs' }]);
  expect(unavailableImports([{ path: 'backend/routes.test.ts', content: "import { test } from 'bun:test';" }], measured)).toEqual([]);
  expect(unavailableImports([{ path: 'backend/main.ts', content: "import { test } from 'bun:test';" }], measured))
    .toEqual([{ path: 'backend/main.ts', line: 1, specifier: 'bun:test' }]);
});

test('environment receipt is private and hashes exactly the bytes written', () => {
  const root = mkdtempSync(join(tmpdir(), 'app-environment-')); roots.push(root);
  const receipt = writeEnvironmentReceipt(root, 'run-123', measured);
  const text = readFileSync(receipt.path, 'utf8');
  expect(statSync(receipt.path).mode & 0o077).toBe(0);
  expect(receipt.sha256).toBe(createHash('sha256').update(text).digest('hex'));
  expect(JSON.parse(text).storageModules).toEqual(['bun:sqlite']);
  expect(readEnvironmentReceipt(root, 'run-123', receipt)).toEqual(measured);
  expect(() => readEnvironmentReceipt(root, 'run-123', { ...receipt, sha256: '0'.repeat(64) })).toThrow('BUILD_ENVIRONMENT_RECEIPT_INVALID');
  chmodSync(receipt.path, 0o644);
  expect(() => writeEnvironmentReceipt(root, 'run-123', measured)).toThrow('BUILD_ENVIRONMENT_RECEIPT_INVALID');
  rmSync(receipt.path);
  const target = join(root, 'target.json'); writeFileSync(target, text, { mode: 0o600 });
  symlinkSync(target, receipt.path);
  expect(() => writeEnvironmentReceipt(root, 'run-123', measured)).toThrow('BUILD_ENVIRONMENT_RECEIPT_INVALID');
});
