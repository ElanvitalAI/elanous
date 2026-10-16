import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkShippedDevDependencies,
  runShippedDevDepGate,
  type ShippedDevDepResult,
} from './ci-shipped-devdep-gate.js';

const packageWith = (devDependencies: Record<string, string>, dependencies: Record<string, string> = {}) => ({
  devDependencies,
  dependencies,
  files: ['src/'],
});

function withFixture(files: Record<string, string>, run: (cwd: string) => void): void {
  const cwd = mkdtempSync(join(tmpdir(), 'shipped-devdep-gate-'));
  try {
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(join(cwd, file, '..'), { recursive: true });
      writeFileSync(join(cwd, file), text);
    }
    run(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe('checkShippedDevDependencies', () => {
  test('reports the known shipped typescript value import with exact file, line, and text', () => {
    const result = checkShippedDevDependencies({
      packageJson: packageWith({ typescript: '^5.7.0' }),
      shippedFiles: [{ file: 'scripts/gate.ts', text: "import ts from 'typescript';\n" }],
    });

    expect(result).toEqual({
      violations: [{ dependency: 'typescript', file: 'scripts/gate.ts', line: 1, text: "import ts from 'typescript';" }],
      scannedFileCount: 1,
      devDependencyNames: ['typescript'],
      measurementFailure: null,
    });
  });

  test('stops reporting when typescript is moved to dependencies', () => {
    const result = checkShippedDevDependencies({
      packageJson: packageWith({}, { typescript: '^5.7.0' }),
      shippedFiles: [{ file: 'scripts/gate.ts', text: "import ts from 'typescript';\n" }],
    });

    expect(result.violations).toEqual([]);
    expect(result.devDependencyNames).toEqual([]);
  });

  test('matches a devDependency subpath but not a prefix-only name', () => {
    const result = checkShippedDevDependencies({
      packageJson: packageWith({ 'devtools-protocol': '^1', diff: '^1' }),
      shippedFiles: [{
        file: 'src/protocol.ts',
        text: "const protocol = require('devtools-protocol/types/protocol');\nimport patch from 'diff-match-patch';\n",
      }],
    });

    expect(result.violations).toEqual([
      {
        dependency: 'devtools-protocol',
        file: 'src/protocol.ts',
        line: 1,
        text: "const protocol = require('devtools-protocol/types/protocol');",
      },
    ]);
  });

  test('excludes all requested type-only import and export forms plus dynamic specifiers', () => {
    const result = checkShippedDevDependencies({
      packageJson: packageWith({ 'devtools-protocol': '^1' }),
      shippedFiles: [{
        file: 'src/types.ts',
        text: [
          "import type Protocol from 'devtools-protocol';",
          "import { type Event } from 'devtools-protocol';",
          "export type { Event } from 'devtools-protocol';",
          "import('devtools-protocol');",
          'require(name);',
        ].join('\n'),
      }],
    });

    expect(result.violations).toEqual([]);
  });

  test('applies files contract to explicit files, globs, exclusions, and shipped test files', () => {
    withFixture({
      'package.json': JSON.stringify({
        devDependencies: { typescript: '^5.7.0' },
        files: ['src/', 'bin/elanous.mjs', 'tools/*.ts', '!src/excluded.ts'],
      }),
      'src/kept.test.ts': "import ts from 'typescript';\n",
      'src/excluded.ts': "import ts from 'typescript';\n",
      'bin/elanous.mjs': "import ts from 'typescript';\n",
      'tools/entry.ts': "import ts from 'typescript';\n",
    }, cwd => {
      const result = checkShippedDevDependencies({ cwd });
      expect(result.measurementFailure).toBeNull();
      expect(result.scannedFileCount).toBe(3);
      expect(result.violations.map(violation => violation.file)).toEqual([
        'bin/elanous.mjs', 'src/kept.test.ts', 'tools/entry.ts',
      ]);
    });
  });

  test('recursively expands directories matched by a files glob', () => {
    withFixture({
      'package.json': JSON.stringify({ devDependencies: { typescript: '^5.7.0' }, files: ['src/*'] }),
      'src/ok.ts': 'export const ok = true;\n',
      'src/nested/bad.ts': "import ts from 'typescript';\n",
    }, cwd => {
      const result = checkShippedDevDependencies({ cwd });
      expect(result.measurementFailure).toBeNull();
      expect(result.scannedFileCount).toBe(2);
      expect(result.violations).toEqual([
        { dependency: 'typescript', file: 'src/nested/bad.ts', line: 1, text: "import ts from 'typescript';" },
      ]);
    });
  });

  test('scans hidden files beneath a shipped directory and reports their value imports', () => {
    withFixture({
      'package.json': JSON.stringify({ devDependencies: { typescript: '^5.7.0' }, files: ['src/'] }),
      'src/ok.ts': 'export const ok = true;\n',
      'src/.internal/bad.ts': "import ts from 'typescript';\n",
    }, cwd => {
      const result = checkShippedDevDependencies({ cwd });
      expect(result.measurementFailure).toBeNull();
      expect(result.scannedFileCount).toBe(2);
      expect(result.violations).toEqual([
        { dependency: 'typescript', file: 'src/.internal/bad.ts', line: 1, text: "import ts from 'typescript';" },
      ]);
    });
  });

  test('keeps no-files and unsupported files-contract measurement failures distinct from a clean zero-violation scan', () => {
    const noFiles = checkShippedDevDependencies({
      packageJson: packageWith({ typescript: '^5.7.0' }),
      shippedFiles: [],
    });
    expect(noFiles.violations).toEqual([]);
    expect(noFiles.scannedFileCount).toBe(0);
    expect(noFiles.measurementFailure).toBe('no shipped source files were scanned');

    withFixture({
      'package.json': JSON.stringify({ devDependencies: { typescript: '^5.7.0' }, files: [''] }),
    }, cwd => {
      expect(checkShippedDevDependencies({ cwd }).measurementFailure).toBe('package.json files contains an empty pattern');
    });
  });

  test('repository-default scan is clean and uses package.json devDependency keys', () => {
    const result = checkShippedDevDependencies({});

    expect(result.measurementFailure).toBeNull();
    expect(result.violations).toEqual([]);
    expect(result.devDependencyNames).toEqual([
      '@copilotkit/aimock',
      '@types/bun',
      '@types/diff',
      '@types/node-cron',
      '@types/web-push',
      'devtools-protocol',
    ]);
    expect(result.scannedFileCount).toBeGreaterThan(0);
  }, 20_000);
});

describe('runShippedDevDepGate', () => {
  const clean: ShippedDevDepResult = {
    violations: [], scannedFileCount: 1, devDependencyNames: ['typescript'], measurementFailure: null,
  };
  const violation: ShippedDevDepResult = {
    violations: [{ dependency: 'typescript', file: 'scripts/gate.ts', line: 1, text: "import ts from 'typescript';" }],
    scannedFileCount: 1, devDependencyNames: ['typescript'], measurementFailure: null,
  };
  const unmeasured: ShippedDevDepResult = {
    violations: [], scannedFileCount: 0, devDependencyNames: ['typescript'], measurementFailure: 'no shipped source files were scanned',
  };

  test('returns clean, violation, and unmeasured CLI exit codes through the injectable runtime caller', () => {
    const logs: string[] = [];
    const errors: string[] = [];
    const run = (result: ShippedDevDepResult) => runShippedDevDepGate({
      check: () => result,
      log: message => logs.push(message),
      error: message => errors.push(message),
    });

    expect(run(clean)).toBe(0);
    expect(run(violation)).toBe(1);
    expect(run(unmeasured)).toBe(1);
    expect(logs).toContain('[shipped-devdep-gate] PASS — no shipped runtime devDependency imports.');
    expect(errors.join('\n')).toContain('scripts/gate.ts:1 typescript');
    expect(errors.join('\n')).toContain('measurement failure: no shipped source files were scanned');
  });
});

// Runtime caller: scripts/ci-shipped-devdep-gate.ts import.meta.main -> runShippedDevDepGate().
