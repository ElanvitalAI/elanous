import { afterEach, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const roots: string[] = [];
const script = join(import.meta.dir, 'remote-worktree-setup.sh');
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(): { root: string; source: string; isolated: string } {
  const root = mkdtempSync(join(homedir(), '.elanous-test-remote-worktree-setup-'));
  roots.push(root);
  const source = join(root, 'source');
  const isolated = join(root, 'isolated');
  mkdirSync(join(source, 'node_modules'), { recursive: true });
  mkdirSync(join(source, 'apps', 'pwa', 'node_modules'), { recursive: true });
  mkdirSync(join(isolated, 'apps', 'pwa'), { recursive: true });
  return { root, source, isolated };
}

test('dry-run describes both dependency links without changing the isolated worktree', () => {
  const { source, isolated } = fixture();
  const result = spawnSync('bash', [script, '--dry-run', source, isolated], { encoding: 'utf8' });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('would link root');
  expect(result.stdout).toContain('would link PWA');
  expect(existsSync(join(isolated, 'node_modules'))).toBe(false);
  expect(existsSync(join(isolated, 'apps', 'pwa', 'node_modules'))).toBe(false);
});

test('apply links root and PWA dependencies and is safe to repeat', () => {
  const { source, isolated } = fixture();
  const first = spawnSync('bash', [script, source, isolated], { encoding: 'utf8' });
  expect(first.status).toBe(0);
  expect(lstatSync(join(isolated, 'node_modules')).isSymbolicLink()).toBe(true);
  expect(lstatSync(join(isolated, 'apps', 'pwa', 'node_modules')).isSymbolicLink()).toBe(true);
  expect(readlinkSync(join(isolated, 'node_modules'))).toBe(join(source, 'node_modules'));
  expect(readlinkSync(join(isolated, 'apps', 'pwa', 'node_modules'))).toBe(join(source, 'apps', 'pwa', 'node_modules'));
  expect(spawnSync('bash', [script, source, isolated], { encoding: 'utf8' }).status).toBe(0);
});

test('missing PWA source dependencies fail before creating either link', () => {
  const { source, isolated } = fixture();
  rmSync(join(source, 'apps', 'pwa', 'node_modules'), { recursive: true, force: true });
  const result = spawnSync('bash', [script, source, isolated], { encoding: 'utf8' });
  expect(result.status).toBe(2);
  expect(result.stderr).toContain('PWA dependencies missing');
  expect(existsSync(join(isolated, 'node_modules'))).toBe(false);
  expect(existsSync(join(isolated, 'apps', 'pwa', 'node_modules'))).toBe(false);
});
