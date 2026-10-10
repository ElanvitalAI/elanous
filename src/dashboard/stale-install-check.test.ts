import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStaleInstallCheck, formatStaleInstallNotice, readCurrentInstalledCommit, readDashboardBootCommit, STALE_INSTALL_CHECK_INTERVAL_MS, versionedDashboardInstallDir } from './stale-install-check.js';

const oldCommit = 'a'.repeat(40);
const newCommit = 'b'.repeat(40);

describe('stale install check', () => {
  test('same; reads on the injected 60-second clock', () => {
    let time = 0;
    let installed = oldCommit;
    let reads = 0;
    const checker = createStaleInstallCheck({
      bootCommit: oldCommit,
      now: () => time,
      readInstalledCommit: () => { reads++; return installed; },
    });
    expect(checker.check()).toEqual({ state: 'same', bootCommit: oldCommit, installedCommit: oldCommit });
    installed = newCommit;
    time = STALE_INSTALL_CHECK_INTERVAL_MS - 1;
    expect(checker.check().state).toBe('same');
    expect(reads).toBe(1);
    time++;
    expect(checker.check().state).toBe('changed');
    expect(reads).toBe(2);
  });

  test('changed; notifies once per installed commit, even after repeated ticks', () => {
    let time = 0;
    let installed = newCommit;
    const checker = createStaleInstallCheck({ bootCommit: oldCommit, now: () => time, readInstalledCommit: () => installed });
    expect(checker.shouldNotify(checker.check())).toBe(true);
    time += STALE_INSTALL_CHECK_INTERVAL_MS;
    expect(checker.check()).toEqual({ state: 'changed', bootCommit: oldCommit, installedCommit: newCommit });
    expect(checker.shouldNotify(checker.check())).toBe(false);
    installed = 'c'.repeat(40);
    time += STALE_INSTALL_CHECK_INTERVAL_MS;
    expect(checker.shouldNotify(checker.check())).toBe(true);
    installed = newCommit;
    time += STALE_INSTALL_CHECK_INTERVAL_MS;
    expect(checker.shouldNotify(checker.check())).toBe(false);
  });

  test('unknown on unreadable or missing commit; never marks notification', () => {
    const thrown = createStaleInstallCheck({ bootCommit: oldCommit, now: () => 0, readInstalledCommit: () => { throw Error('unreadable'); } });
    const result = thrown.check();
    expect(result).toEqual({ state: 'unknown', bootCommit: oldCommit, installedCommit: undefined });
    expect(thrown.shouldNotify(result)).toBe(false);
    expect(createStaleInstallCheck({ bootCommit: undefined, now: () => 0, readInstalledCommit: () => oldCommit }).check().state).toBe('unknown');
  });

  test('not-installed when the running code root is outside versions; no installed read', () => {
    const root = mkdtempSync(join(tmpdir(), 'dashboard-version-'));
    try {
      const worktree = join(root, 'worktree');
      mkdirSync(worktree);
      let reads = 0;
      const checker = createStaleInstallCheck({ codeRoot: worktree, installRoot: root, bootCommit: oldCommit, now: () => 0, readInstalledCommit: () => { reads++; return newCommit; } });
      expect(checker.check()).toEqual({ state: 'not-installed', bootCommit: oldCommit, installedCommit: undefined });
      expect(reads).toBe(0);
      expect(checker.shouldNotify(checker.check())).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('formats first and third installed versions from boot and installed commits', () => {
    const first = formatStaleInstallNotice({ state: 'changed', bootCommit: 'abc1234'.padEnd(40, 'a'), installedCommit: 'def5678'.padEnd(40, 'd') }, 1);
    const third = formatStaleInstallNotice({ state: 'changed', bootCommit: 'abc1234'.padEnd(40, 'a'), installedCommit: 'ghi9012'.padEnd(40, 'g') }, 3);
    expect(first).toBe('새 판이 깔렸습니다 (부팅 판 abc1234 → 지금 def5678) · TUI 를 다시 띄우면 새 판으로 돕니다');
    expect(third).toBe('새 판이 깔렸습니다 (부팅 판 abc1234 → 지금 ghi9012) · TUI 를 다시 띄우면 새 판으로 돕니다 · 이 TUI 가 뜬 뒤 3번째 새 판');
    expect(first).not.toContain('3번째 새 판');
  });

  test('realpaths the install root when matching a version but preserves the install-root path for metadata', () => {
    const root = mkdtempSync(join(tmpdir(), 'dashboard-version-'));
    try {
      const actualRoot = join(root, 'actual');
      const aliasRoot = join(root, 'alias');
      const version = join(actualRoot, 'versions', 'v1');
      const packageRoot = join(version, 'node_modules', 'elanous');
      mkdirSync(packageRoot, { recursive: true });
      symlinkSync(actualRoot, aliasRoot, 'dir');
      expect(versionedDashboardInstallDir(join(aliasRoot, 'versions', 'v1', 'node_modules', 'elanous'), aliasRoot))
        .toBe(join(aliasRoot, 'versions', 'v1'));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('the immutable boot version and the current symlink use the shared install metadata parser', () => {
    const root = mkdtempSync(join(tmpdir(), 'dashboard-version-'));
    try {
      const version = join(root, 'versions', 'v1');
      const packageRoot = join(version, 'node_modules', 'elanous');
      mkdirSync(packageRoot, { recursive: true });
      mkdirSync(join(root, 'current'));
      writeFileSync(join(version, 'install.json'), JSON.stringify({ commit: oldCommit }));
      writeFileSync(join(root, 'current', 'install.json'), JSON.stringify({ commit: newCommit }));
      expect(versionedDashboardInstallDir(packageRoot, root)).toBe(version);
      expect(readDashboardBootCommit(version)).toBe(oldCommit);
      expect(readCurrentInstalledCommit(root)).toBe(newCommit);
      writeFileSync(join(root, 'current', 'install.json'), '{');
      expect(readCurrentInstalledCommit(root)).toBeUndefined();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
