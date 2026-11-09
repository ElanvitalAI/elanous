import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { removeWorktreeDependencyScratch } from './worktree.js';
import { debug } from '../debug/log.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) removeWorktreeDependencyScratch(root, root);
});

describe('removeWorktreeDependencyScratch', () => {
  test('cleans a read-only dependency cache inside scratch without changing a symlink target', () => {
    const parent = mkdtempSync(join(tmpdir(), 'worktree-dependency-scratch-'));
    roots.push(parent);
    const scratch = join(parent, 'run-scratch');
    const cacheFile = join(scratch, 'state', 'worktree-deps', 'scope', 'digest', 'pkg', 'index.js');
    const sharedStore = join(parent, 'persistent-shared-store');
    const sharedFile = join(sharedStore, 'index.js');
    mkdirSync(dirname(cacheFile), { recursive: true });
    mkdirSync(sharedStore);
    writeFileSync(cacheFile, 'scratch cache');
    writeFileSync(sharedFile, 'shared cache');
    chmodSync(sharedFile, 0o444);
    symlinkSync(sharedStore, join(scratch, 'shared-store-link'), 'dir');

    for (const directory of [
      join(scratch, 'state', 'worktree-deps', 'scope', 'digest', 'pkg'),
      join(scratch, 'state', 'worktree-deps', 'scope', 'digest'),
      join(scratch, 'state', 'worktree-deps', 'scope'),
      join(scratch, 'state', 'worktree-deps'),
      join(scratch, 'state'),
      scratch,
    ]) chmodSync(directory, 0o555);

    expect(removeWorktreeDependencyScratch(scratch, scratch)).toBe(true);
    expect(() => lstatSync(scratch)).toThrow();
    expect(readFileSync(sharedFile, 'utf8')).toBe('shared cache');
    expect(lstatSync(sharedFile).mode & 0o777).toBe(0o444);
  });

  test('refuses a real path that escapes the current scratch root', () => {
    const parent = mkdtempSync(join(tmpdir(), 'worktree-dependency-scratch-boundary-'));
    roots.push(parent);
    const scratch = join(parent, 'run-scratch');
    const outside = join(parent, 'shared-store');
    mkdirSync(scratch);
    mkdirSync(outside);
    const sharedFile = join(outside, 'index.js');
    writeFileSync(sharedFile, 'persistent');
    chmodSync(outside, 0o555);
    const log = spyOn(debug, 'log');
    try {
      expect(removeWorktreeDependencyScratch(outside, scratch)).toBe(false);
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0]?.[1]).toBe('dependency-scratch.cleanup-failed');
    } finally {
      log.mockRestore();
    }
    expect(readFileSync(sharedFile, 'utf8')).toBe('persistent');
    expect(lstatSync(outside).mode & 0o777).toBe(0o555);
  });

  test('refuses an intermediate symlink even when its real target is inside scratch', () => {
    const parent = mkdtempSync(join(tmpdir(), 'worktree-dependency-scratch-symlink-'));
    roots.push(parent);
    const scratch = join(parent, 'scratch');
    const nested = join(scratch, 'kept', 'sub');
    mkdirSync(nested, { recursive: true });
    const keptFile = join(nested, 'keep.txt');
    writeFileSync(keptFile, 'keep');
    symlinkSync(join(scratch, 'kept'), join(scratch, 'link'), 'dir');

    const log = spyOn(debug, 'log');
    try {
      expect(removeWorktreeDependencyScratch(join(scratch, 'link', 'sub'), scratch)).toBe(false);
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0]?.[1]).toBe('dependency-scratch.cleanup-failed');
      expect(readFileSync(keptFile, 'utf8')).toBe('keep');
    } finally {
      log.mockRestore();
    }
  });

  test('checks original components before resolving dot-dot after a symlink', () => {
    const parent = mkdtempSync(join(tmpdir(), 'worktree-dependency-scratch-symlink-dotdot-'));
    roots.push(parent);
    const scratch = join(parent, 'scratch');
    const kept = join(scratch, 'sub', 'keep.txt');
    mkdirSync(dirname(kept), { recursive: true });
    writeFileSync(kept, 'keep');
    mkdirSync(join(scratch, 'keep', 'sub'), { recursive: true });
    symlinkSync(join(scratch, 'keep'), join(scratch, 'link'), 'dir');

    const log = spyOn(debug, 'log');
    try {
      expect(removeWorktreeDependencyScratch(`${scratch}/link/../sub`, scratch)).toBe(false);
      expect(log).toHaveBeenCalledTimes(1);
      expect(readFileSync(kept, 'utf8')).toBe('keep');
    } finally {
      log.mockRestore();
    }
  });

  test('checks original components in a relative target path before dot-dot resolution', () => {
    const parent = mkdtempSync(join(tmpdir(), 'worktree-dependency-scratch-relative-symlink-'));
    roots.push(parent);
    const scratch = join(parent, 'scratch');
    const kept = join(scratch, 'sub', 'keep.txt');
    mkdirSync(dirname(kept), { recursive: true });
    writeFileSync(kept, 'keep');
    mkdirSync(join(scratch, 'keep', 'sub'), { recursive: true });
    symlinkSync(join(scratch, 'keep'), join(scratch, 'link'), 'dir');

    const previousCwd = process.cwd();
    process.chdir(parent);
    const log = spyOn(debug, 'log');
    try {
      expect(removeWorktreeDependencyScratch('scratch/link/../sub', scratch)).toBe(false);
      expect(log).toHaveBeenCalledTimes(1);
      expect(readFileSync(kept, 'utf8')).toBe('keep');
    } finally {
      log.mockRestore();
      process.chdir(previousCwd);
    }
  });

  test('accepts a valid relative target when cwd is the filesystem root', () => {
    const parent = mkdtempSync(join(tmpdir(), 'worktree-dependency-scratch-root-cwd-'));
    roots.push(parent);
    const scratch = join(parent, 'scratch');
    const target = join(scratch, 'target');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'cache.txt'), 'disposable');

    const previousCwd = process.cwd();
    process.chdir('/');
    try {
      expect(removeWorktreeDependencyScratch(target.slice(1), scratch)).toBe(true);
      expect(() => lstatSync(target)).toThrow();
    } finally {
      process.chdir(previousCwd);
    }
  });
});
