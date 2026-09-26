import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveInstance } from './resolve.js';

const prodRoot = '/tmp/elanous-prod';
const sourceRoot = '/tmp/elanous-source/.elanous-test';

describe('leader-independent universe selection', () => {
  test('explicit roots outrank stamps, installed execution and source trees', () => {
    expect(resolveInstance({ explicitFlagRoot: prodRoot, stampedStateDir: sourceRoot, installedCopy: false, treeTestRoot: sourceRoot, prodRoot })).toMatchObject({ kind: 'prod', root: prodRoot, layer: 'explicit-flag' });
    expect(resolveInstance({ explicitFlagRoot: sourceRoot, installedCopy: true, prodRoot })).toMatchObject({ kind: 'test', layer: 'explicit-flag' });
    expect(resolveInstance({ stampedStateDir: prodRoot, installedCopy: false, treeTestRoot: sourceRoot, prodRoot })).toMatchObject({ kind: 'prod', layer: 'parent-stamp' });
    expect(resolveInstance({ stampedStateDir: sourceRoot, installedCopy: true, prodRoot })).toMatchObject({ kind: 'test', layer: 'parent-stamp' });
  });

  test('installed build operates; every unstamped source tree isolates regardless of depth', () => {
    expect(resolveInstance({ installedCopy: true, treeTestRoot: sourceRoot, prodRoot })).toMatchObject({ kind: 'prod', root: prodRoot, layer: 'installed' });
    expect(resolveInstance({ installedCopy: false, axes: { selfInstalled: true }, treeTestRoot: sourceRoot, prodRoot })).toMatchObject({ kind: 'test', root: sourceRoot });
    for (const depth of [0, 2]) {
      expect(resolveInstance({ installedCopy: false, treeTestRoot: sourceRoot, prodRoot, depth })).toMatchObject({ kind: 'test', root: sourceRoot, layer: 'tree-derived' });
    }
  });

  test('actual where --json isolates the executing source tree even when cwd is a different tree', () => {
    const temp = mkdtempSync(join(tmpdir(), 'elanous-where-'));
    try {
      mkdirSync(join(temp, '.git'));
      const home = join(temp, 'home');
      mkdirSync(join(home, '.elanous'), { recursive: true });
      for (const leader of [true, false]) {
        if (leader) writeFileSync(join(home, '.elanous', 'leader.json'), JSON.stringify({ tree: temp }));
        else rmSync(join(home, '.elanous', 'leader.json'), { force: true });
        const run = spawnSync('bun', [join(process.cwd(), 'bin/elanous.mjs'), 'where', '--json'], {
          cwd: temp, encoding: 'utf8', timeout: 90_000,
          env: { ...process.env, HOME: home, BUN_INSTALL_CACHE_DIR: join(homedir(), '.bun', 'install', 'cache'), ELANOUS_STATE_DIR: '', ELANOUS_CONFIG_DIR: '', ELANOUS_TEST_STATE_DIR: '' },
        });
        expect(run.status, run.stderr).toBe(0);
        const output = JSON.parse(run.stdout.slice(run.stdout.indexOf('{'))) as Record<string, unknown>;
        expect(output.kind).toBe('test');
        expect(output.root).toBe(join(process.cwd(), '.elanous-test'));
        expect(output.layer).toBe('tree-derived');
        expect(output.mismatch).toBeNull();
        expect(output).not.toHaveProperty('authority');
        expect(output).not.toHaveProperty('isLeader');
      }
    } finally { rmSync(temp, { recursive: true, force: true }); }
  }, 180_000);
});
