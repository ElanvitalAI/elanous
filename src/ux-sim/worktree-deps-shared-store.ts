/**
 * Isolated UX simulation helpers for the production worktree dependency linker.
 * All fixture paths are caller-owned temporary directories; no repository or
 * user dependency tree is modified.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface DependencySourceSnapshot {
  readonly files: Readonly<Record<string, string>>;
}

export function seedWorktreeDependencyRepository(root: string, lockContents = 'lock-v1\n'): void {
  mkdirSync(join(root, 'node_modules', 'fixture-pkg'), { recursive: true });
  mkdirSync(join(root, 'apps', 'pwa', 'node_modules', 'fixture-pwa'), { recursive: true });
  writeFileSync(join(root, '.gitignore'), 'node_modules\n');
  writeFileSync(join(root, 'package.json'), '{"name":"worktree-deps-sim","version":"1.0.0"}\n');
  writeFileSync(join(root, 'bun.lock'), lockContents);
  writeFileSync(join(root, 'node_modules', 'fixture-pkg', 'index.js'), 'export const value = "root-v1";\n');
  writeFileSync(join(root, 'apps', 'pwa', 'package.json'), '{"name":"worktree-deps-pwa-sim","version":"1.0.0"}\n');
  writeFileSync(join(root, 'apps', 'pwa', 'bun.lock'), lockContents);
  writeFileSync(join(root, 'apps', 'pwa', 'node_modules', 'fixture-pwa', 'index.js'), 'export const value = "pwa-v1";\n');
}

export function snapshotDependencySource(root: string): DependencySourceSnapshot {
  const paths = [
    '.gitignore',
    'package.json',
    'bun.lock',
    'node_modules/fixture-pkg/index.js',
    'apps/pwa/package.json',
    'apps/pwa/bun.lock',
    'apps/pwa/node_modules/fixture-pwa/index.js',
  ];
  return {
    files: Object.fromEntries(paths.map((path) => [path, createHash('sha256').update(readFileSync(join(root, path))).digest('hex')])),
  };
}

export function readWorktreeCreatedAt(worktreePath: string): string | null {
  const result = spawnSync('git', ['config', '--worktree', '--get', 'elanous.harness.createdAt'], { cwd: worktreePath, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}
