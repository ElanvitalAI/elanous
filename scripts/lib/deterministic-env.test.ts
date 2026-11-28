import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isCredentialKey, prepareDeterministicChildEnvironment } from './deterministic-env.js';

const originalEnv = { ...process.env };
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe('prepareDeterministicChildEnvironment', () => {
  test('strips credential-shaped keys while redirecting deterministic roots', () => {
    process.env.ANTHROPIC_API_KEY = 'live-secret';
    process.env.APIFY_TOKEN = 'live-token';
    process.env.OPENAI_BASE_URL = 'https://example.invalid';
    process.env.ELANOUS_STATE_DIR = '/real/state';
    process.env.ELANOUS_CONFIG_DIR = '/real/config';

    const isolated = prepareDeterministicChildEnvironment('elanous-deterministic-env-test-');
    cleanups.push(isolated.cleanup);

    expect(isCredentialKey('ANTHROPIC_API_KEY')).toBe(true);
    expect(isolated.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(isolated.env.APIFY_TOKEN).toBeUndefined();
    expect(isolated.env.OPENAI_BASE_URL).toBe('https://example.invalid');
    expect(isolated.env.HOME).toBe(isolated.root);
    expect(isolated.env.XDG_CONFIG_HOME).toBe(`${isolated.root}/.config`);
    expect(isolated.env.ELANOUS_STATE_DIR).toBe(`${isolated.root}/state`);
    expect(isolated.env.ELANOUS_CONFIG_DIR).toBe(`${isolated.root}/config`);
    expect(existsSync(isolated.root)).toBe(true);
  });

  test('cleanup removes the per-run root and is idempotent', () => {
    const isolated = prepareDeterministicChildEnvironment('elanous-deterministic-env-test-');
    expect(existsSync(isolated.root)).toBe(true);
    isolated.cleanup();
    isolated.cleanup();
    expect(existsSync(isolated.root)).toBe(false);
  });

  test('cleans a real readonly dependency tree', () => {
    const isolated = prepareDeterministicChildEnvironment('elanous-gate-real-readonly-');
    const deps = join(isolated.root, 'state', 'worktree-deps', 'node_modules');
    mkdirSync(deps, { recursive: true });
    writeFileSync(join(deps, 'file'), 'test');
    chmodSync(deps, 0o555);
    isolated.cleanup();
    expect(existsSync(isolated.root)).toBe(false);
  });

  test('cleans readonly dependency directories without touching a shared symlink target', () => {
    const outside = mkdtempSync(join(tmpdir(), 'elanous-gate-outside-'));
    const externalFile = join(outside, 'keep');
    writeFileSync(externalFile, 'keep');
    chmodSync(outside, 0o555);
    let calls = 0;
    const isolated = prepareDeterministicChildEnvironment('elanous-gate-readonly-', {
      rmSync: (path, options) => {
        if (++calls === 1) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        rmSync(path, options);
      },
    });
    const deps = join(isolated.root, 'state', 'worktree-deps', 'node_modules');
    try {
      mkdirSync(deps, { recursive: true });
      writeFileSync(join(deps, 'file'), 'test');
      symlinkSync(outside, join(deps, 'shared'));
      chmodSync(deps, 0o555);
      isolated.cleanup();
      expect(calls).toBe(2);
      expect(existsSync(isolated.root)).toBe(false);
      expect(readFileSync(externalFile, 'utf8')).toBe('keep');
      expect(lstatSync(outside).mode & 0o777).toBe(0o555);
    } finally {
      chmodSync(outside, 0o700);
      rmSync(outside, { recursive: true, force: true });
      isolated.cleanup();
    }
  });

  test('cleanup retries after a removal failure', () => {
    const root = mkdtempSync(join(tmpdir(), 'elanous-deterministic-env-retry-'));
    let calls = 0;
    const isolated = prepareDeterministicChildEnvironment('elanous-deterministic-env-test-', {
      mkdtempSync: (_prefix: string) => root,
      rmSync: (path, options) => {
        calls += 1;
        if (calls === 1) throw new Error('first removal failed');
        rmSync(path, options);
      },
    });
    expect(() => isolated.cleanup()).toThrow('first removal failed');
    expect(existsSync(root)).toBe(true);
    isolated.cleanup();
    expect(calls).toBe(2);
    expect(existsSync(root)).toBe(false);
  });

  test('throws on preparation failure instead of returning the parent environment', () => {
    process.env.ANTHROPIC_API_KEY = 'parent-secret';
    expect(() => prepareDeterministicChildEnvironment('elanous-deterministic-env-test-', {
      mkdtempSync: () => { throw new Error('cannot create isolated root'); },
    })).toThrow('cannot create isolated root');
  });
});
