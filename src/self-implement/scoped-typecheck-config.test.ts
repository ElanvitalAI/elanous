import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { writeScopedTypecheckConfig } from './scoped-typecheck-config.js';

function fixture(): string {
  // realpath: macOS tmpdir is a symlink (/var → /private/var) and the config path comes back resolved.
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'scoped-typecheck-config-')));
  mkdirSync(join(cwd, 'src'), { recursive: true });
  writeFileSync(join(cwd, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, noEmit: true, target: 'ES2022', types: [] },
    include: ['src/**/*.ts'],
  }));
  writeFileSync(join(cwd, 'src', 'changed.ts'), 'export const changed: number = 1;\n');
  writeFileSync(join(cwd, 'src', 'unrelated.ts'), 'export const unrelated: number = "broken";\n');
  return cwd;
}

describe('writeScopedTypecheckConfig', () => {
  test('only existing regular files are included, deduplicated and relative to the config directory', () => {
    const cwd = fixture();
    mkdirSync(join(cwd, 'apps/pwa/src'), { recursive: true });
    writeFileSync(join(cwd, 'apps/pwa/tsconfig.json'), JSON.stringify({ extends: '../../tsconfig.json' }));
    writeFileSync(join(cwd, 'apps/pwa/src/view.tsx'), 'export const view = 1;\n');
    try {
      const scoped = writeScopedTypecheckConfig(cwd, 'apps/pwa/tsconfig.json', [
        'apps/pwa/src/view.tsx', 'apps/pwa/src/view.tsx', './src/changed.ts',
        'apps/pwa/src/deleted.tsx', 'apps/pwa/src', '../outside.ts',
      ]);
      expect(scoped).not.toBeNull();
      try {
        const config = JSON.parse(readFileSync(scoped!.config, 'utf8'));
        expect(dirname(scoped!.config)).toBe(join(cwd, 'apps/pwa'));
        expect(config).toEqual({
          extends: join(cwd, 'apps/pwa/tsconfig.json'),
          files: ['src/view.tsx', '../../src/changed.ts'],
          include: [], exclude: [],
        });
      } finally {
        scoped!.cleanup();
      }
      expect(existsSync(scoped!.config)).toBe(false);
      expect(existsSync(join(cwd, 'apps/pwa/tsconfig.json'))).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('ambient declarations from the inherited project survive scoped roots without importing them', () => {
    const cwd = fixture();
    try {
      writeFileSync(join(cwd, 'src/globals.d.ts'), 'declare const PROJECT_GLOBAL: number;\n');
      writeFileSync(join(cwd, 'src/changed.ts'), 'export const changed: number = PROJECT_GLOBAL;\n');
      const scoped = writeScopedTypecheckConfig(cwd, 'tsconfig.json', ['src/changed.ts']);
      expect(scoped).not.toBeNull();
      try {
        const config = JSON.parse(readFileSync(scoped!.config, 'utf8')) as { files: string[] };
        expect(config.files).toEqual(['src/changed.ts', 'src/globals.d.ts']);
        const checked = spawnSync('bunx', ['tsc', '--noEmit', '-p', scoped!.config], { cwd, encoding: 'utf8', timeout: 30_000 });
        expect(checked.status).toBe(0);
        expect(checked.stdout).not.toContain('TS2304');
      } finally {
        scoped!.cleanup();
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 90_000);

  test('missing or deleted inputs produce null without creating a config', () => {
    const cwd = fixture();
    try {
      const before = readdirSync(cwd).sort();
      expect(writeScopedTypecheckConfig(cwd, 'tsconfig.json', [])).toBeNull();
      expect(writeScopedTypecheckConfig(cwd, 'tsconfig.json', ['src/gone.ts', 'src'])).toBeNull();
      expect(readdirSync(cwd).sort()).toEqual(before);
      expect(readFileSync(join(cwd, 'tsconfig.json'), 'utf8')).toContain('src/**/*.ts');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('tsc uses only the scoped roots while retaining inherited compiler options and cleanup removes the generated config', () => {
    const cwd = fixture();
    try {
      const scoped = writeScopedTypecheckConfig(cwd, 'tsconfig.json', ['src/changed.ts']);
      expect(scoped).not.toBeNull();
      try {
        const result = spawnSync('bunx', ['tsc', '--noEmit', '-p', scoped!.config, '--listFilesOnly'], {
          cwd, encoding: 'utf8', timeout: 30_000,
        });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain(join(cwd, 'src/changed.ts'));
        expect(result.stdout).not.toContain(join(cwd, 'src/unrelated.ts'));
        const clean = spawnSync('bunx', ['tsc', '--noEmit', '-p', scoped!.config], { cwd, encoding: 'utf8', timeout: 30_000 });
        expect(clean.status).toBe(0);
        writeFileSync(join(cwd, 'src/changed.ts'), 'export const changed: number = "broken";\n');
        const broken = spawnSync('bunx', ['tsc', '--noEmit', '-p', scoped!.config], { cwd, encoding: 'utf8', timeout: 30_000 });
        expect(broken.status).not.toBe(0);
        expect(broken.stdout).toContain('src/changed.ts');
        expect(broken.stdout).not.toContain('src/unrelated.ts');
      } finally {
        scoped!.cleanup();
      }
      expect(existsSync(scoped!.config)).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 90_000);
});
